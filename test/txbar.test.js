// 1.99?? transcripts bar (owner 2026-11-02: "If someone has !transcripts off, it should still show in the chat but blocked out like with
// bridge hide. Admins should be able to see through this like the other privacy toggles." + "Should also be clippable by admins like
// the bridge off."): the site's half, through the REAL routes with the privacy wire v2 ON. Pepe sends a !transcripts off speaker's 🎙
// line as a v2-only line with priv.tx: true and their words in priv.words (camfrog-bot txbar_test.py; the shared contract's txbar_*
// cases) - this site stores and shows it EXACTLY like a hidden speaker's 🎙 line:
//   * the advert (txbar: 1 in every sync answer while the switch is on) and Pepe's cap (txbar_cap: 1 -> privwire.txBar, kept)
//   * the item: u {anon, "someone", veil hidden}, a bar, tm: 1 (server-only), no words; the identity + words only in bridge_veil; a named
//     speaker gets NO frog-name session ("someone"); an incognito one keeps their incognito frog name (the session isn't ended); a
//     !bridge hide one gets one bar; a malformed priv.tx is dropped
//   * the sticky !transcripts off set never leaves the bar out (it does leave out their 🎙 lines that carry words, as before)
//   * every surface as a hidden line: the live view (member, staff, owner, admin: the same, rv flags only), history (a bar - read in SQL,
//     masked by the projection), search (never), downloads ([hidden] / masked), quotes and member clips (never), evidence (offered to
//     the see-through roles), the speaker's own view (their words, "only you"), Download my data (their words), forget-me
//   * see-through: admins and the pad's owner (their era) reveal the words; members and staff can't; every reveal logged with scope
//     tx_line (a hidden line's reveal stays chat_line; the toggle's batches add a tx_line row)
//   node --test test/txbar.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "txbar-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
delete process.env.PUBLIC_BASE_URL;
delete process.env.SITE_URL;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "cd".repeat(32);
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.MICCLIP_DIR = path.join(tmp, "micclip");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
process.env.EVIDENCE_DIR = path.join(tmp, "evidence");            // (review fixes: an evidence clip is stored below - never next to the repo)
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PW = require(path.join(repo, "privwire"));
const FN = require(path.join(repo, "frognames"));
const X = require(path.join(repo, "chatlogexport"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Txbar.Room", name: "Txbar Room" }, SLUG = "txbar-room";
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]{1,15} [A-Z][A-Za-z]{1,15}|Mystery Frog \d{1,4})$/;
const users = new Map();
const U = {};
let base, server, seq = 0;
const real = (login, display, extra = {}) => Object.assign({ id: login.toLowerCase(), login, display: display || login }, extra);
const ALICE = real("alicecf", "Alice");
const TI = "tinatxoff", FR = "frankietxinc", HK = "hanktxhid";
// the words of each bar: tokens nothing else says (an index hit or a page match can only be a leak)
const W = { tina: "quokkatina zebrafinch said on the mic", fr: "marzipanowl frankie mic words here", hk: "periwinkleyak hank mic words" };
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
const bar = (kind, login, words, extra = {}) => priv(kind, login, Object.assign({ words, tx: true }, extra));
const ev = (type, data, ts = Date.now()) => ({ op: "event", id: "tb-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
// Pepe on v2: his kinded lists (frankie incognito, hank !bridge hide) and !transcripts off (tina, frankie, hank) on every batch
const KINDED = () => ({ bridge_hidden_h: [hash(HK)], incog_hidden_h: [hash(FR)], tx_hidden_h: [hash(TI), hash(FR), hash(HK)], txbar_cap: 1 });
const sync = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [] }, KINDED(), extra), { v2: true });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const NEEDLES = [W.tina, W.fr, W.hk, "quokkatina", "marzipanowl", "periwinkleyak", hash(TI), hash(FR), hash(HK), FR, HK, "\"_vz\"", "\"vw\"", "\"priv\"", "\"tm\""];
const leaks = (s) => NEEDLES.filter((x) => String(s).toLowerCase().includes(x.toLowerCase()));

function call(method, url, { user = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => { const s = Buffer.concat(parts).toString("utf8"); let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s }); });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const live = (user) => call("GET", `/api/rooms/${SLUG}/live`, { user });
const R = () => bridge._rooms.get(ROOM.id);
const C = {};                                    // the fixture's lines: name -> c

const H1 = "hd-0000ab0000c1", H2 = "hd-0000ab0000c2";
const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.staff = await mkUser("helper", "Staff");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.tina = await mkUser("tina", "pleb", TI);                   // the !transcripts off speaker's own account
  await rooms.init();
  await require(path.join(repo, "feedstore")).init();
  await settle(100);
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const isBotToken = (t) => t === "bot";
  bridge.register(app, { addUser, isBotToken });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  PW.register(app, { addUser, noTimers: true });
  require(path.join(repo, "seethrough")).register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history", "search", "downloads"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  await rooms.setOwner(ROOM.id, "own", "test");
  await sync([], { rooms: [{ room: ROOM, members: [ALICE, real(TI, "Tina")], mic: [], count: 2, transcripts: true }] });
  await require(path.join(repo, "padaccess")).setLevel(U.own, { id: ROOM.id }, "public");
  await CV.reconcileNow(ROOM.id).catch(() => {});
  // the owner's era began an hour ago (the lines below are said inside it: the owner may reveal them)
  await runQuery("UPDATE room_events SET ts = ? WHERE room_id = ? AND what = 'owner'", [Date.now() - 3600e3, ROOM.id]);
  await runQuery("UPDATE chatlog_rooms SET owner_since = ? WHERE room_id = ?", [Date.now() - 3600e3, ROOM.id]);
  const t0 = Date.now() - 10 * 60e3;
  const roster = [ALICE, real(TI, "Tina"), real(FR, "Frankie", { priv: priv("incognito", FR), src: "list" }),
                  real(HK, "Hank", { priv: priv("hidden", HK), src: "list" })];
  // tina's 🎙 line from BEFORE she turned transcripts off (named, with words) - left out once she has (as before)
  await sync([ev("x.pepe.transcript", { id: "tx-00000000000000b0", user: real(TI, "Tina"), text: "tina said this earlier with transcripts on",
                                        source: "mic", said_at: t0 / 1000 - 30 }, t0 - 20000)], { tx_hidden_h: [] });
  await settle();
  C.before = R().feed.find((it) => it.text === "tina said this earlier with transcripts on").c;
  // Pepe's privacy events (as he sends them) + the roster; tina's named hold and typed line; then her 🎙 line as a bar
  const tiP = real(TI, "Tina", { proven: true, since: t0 / 1000 });
  await sync([
    { op: "event", id: "tb-ph-1", ts: new Date(t0 - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(TI), scope: "tx" } },
    { op: "event", id: "tb-ph-2", ts: new Date(t0 - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(FR), scope: "incognito" } },
    { op: "event", id: "tb-ph-3", ts: new Date(t0 - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(FR), scope: "tx" } },
    { op: "event", id: "tb-ph-4", ts: new Date(t0 - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(HK), scope: "bridge" } },
    { op: "event", id: "tb-ph-5", ts: new Date(t0 - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(HK), scope: "tx" } },
    ev("mic.grab", { user: tiP, hold: H1 }, t0),
    ev("mic.release", { user: tiP, hold: H1, held_ms: 8000 }, t0 + 8000),
    ev("message", { user: real(TI, "Tina"), text: "tina typed this line" }, t0 + 9000),
    ev("x.pepe.transcript", { id: "tx-00000000000000b1", user: real(TI, "Tina"), source: "mic", hold: H1, said_at: t0 / 1000 + 1,
                              priv: bar("tx", TI, W.tina) }, t0 + 12000),
    // frankie: incognito AND transcripts off - a typed line (his frog name, his words), then his 🎙 line as a bar under the same name
    ev("message", { user: real(FR, "Frankie"), text: "frankie typed hello", priv: priv("incognito", FR) }, t0 + 20000),
    ev("x.pepe.transcript", { id: "tx-00000000000000b2", user: real(FR, "Frankie"), source: "mic", said_at: t0 / 1000 + 21,
                              priv: bar("incognito", FR, W.fr) }, t0 + 23000),
    ev("message", { user: real(FR, "Frankie"), text: "frankie typed again", priv: priv("incognito", FR) }, t0 + 24000),
    // hank: !bridge hide AND transcripts off - one bar
    ev("x.pepe.transcript", { id: "tx-00000000000000b3", user: real(HK, "Hank"), source: "mic", said_at: t0 / 1000 + 30,
                              priv: bar("hidden", HK, W.hk) }, t0 + 32000),
    // malformed: never stored (a message can't carry tx; tx must be true; kind tx needs tx)
    ev("message", { user: real(TI, "Tina"), priv: bar("tx", TI, "malformed message words") }, t0 + 40000),
    ev("x.pepe.transcript", { id: "tx-00000000000000b4", user: real(TI, "Tina"), source: "mic", said_at: t0 / 1000 + 41,
                              priv: priv("tx", TI, { words: "malformed no tx flag" }) }, t0 + 41000),
    ev("x.pepe.transcript", { id: "tx-00000000000000b5", user: real(TI, "Tina"), source: "mic", said_at: t0 / 1000 + 42,
                              priv: priv("tx", TI, { words: "malformed tx yes", tx: "yes" }) }, t0 + 42000),
  ], { rooms: [{ room: ROOM, members: roster, mic: [], count: 4, transcripts: true }] });
  await settle(120);
  const f = (pred) => { const it = R().feed.find(pred); return it ? it.c : null; };
  C.tina = f((it) => it._vz && it._vz.login === TI && it.k === "tx");
  C.fr = f((it) => it._vz && it._vz.login === FR && it.k === "tx");
  C.frMsg = f((it) => it._vz && it._vz.login === FR && it.k === "msg" && it.text === "frankie typed hello");
  C.hk = f((it) => it._vz && it._vz.login === HK && it.k === "tx");
  await CV.init();
  await require(path.join(repo, "chatlogmod")).init();
  await CV.refreshNames();
  CV._clearCaches();
})();
const ready = async () => { await setup; CV._clearCaches(); };

test("the advert and Pepe's cap: txbar: 1 in every answer while the switch is on; txBar() = the switch AND a Pepe that sends it (kept)", async () => {
  await ready();
  const v1 = await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], txbar_cap: 1 } });
  assert.equal(v1.status, 200);
  assert.equal(v1.d.txbar, 1, "a v1 answer says txbar: 1 while privacy wire v2 is on");
  assert.equal(v1.d.privwire, 2);
  await settle();
  assert.equal(PW.txBar(), true, "the switch on + txbar_cap: 1 -> the bar's text is live");
  const row = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'privwire_txcap'"))[0];
  assert.equal(JSON.parse(row.value).cap, true, "kept (a restart doesn't flip the text back)");
  await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [] } });
  await settle();
  assert.equal(PW.txBar(), false, "a sync from a Pepe without the cap (an older one) - the old text again");
  await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], txbar_cap: 1 } });
  await settle();
  assert.equal(PW.txBar(), true);
  const adm = await call("GET", "/api/admin/privwire", { user: U.adm });
  assert.deepEqual([adm.d.txbar.on, adm.d.txbar.cap], [true, true], "the admin card says so");
  await PW.setOn(false, { userId: U.adm.userId, username: "adm" });
  const off = await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], txbar_cap: 1 } });
  assert.ok(!("txbar" in off.d) && !("privwire" in off.d), "switch off: no advert");
  assert.equal(PW.txBar(), false, "switch off: no bar text, whatever Pepe can do");
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  assert.equal(PW.txBar(), true);
});

test("the stored item: a hidden 🎙 line's shape + tm; identity and words only in bridge_veil; no frog name for a named speaker; malformed ones dropped", async () => {
  await ready();
  for (const k of ["tina", "fr", "hk"]) assert.ok(C[k], "stored: " + k);
  const it = R().feed.find((x) => x.c === C.tina);
  assert.deepEqual(it.u, { anon: true, display: "someone", veil: "hidden" }, "u: 'someone', hidden - no frog name");
  assert.ok(/^[sml]$/.test(it.mask) && !("text" in it) && it.tm === 1, "a bar, tm: 1, no words");
  assert.equal(it._vz.login, TI);
  assert.equal(it._vz.kind, "hidden", "stored as a hidden line (reveal, evidence, archive, retention)");
  assert.equal(it._vz.tx, 1);
  assert.equal(it._vw, W.tina);
  const stored = (await getQuery("SELECT data FROM bridge_feed WHERE c = ?", [C.tina]))[0].data;
  assert.ok(!stored.includes(W.tina) && !stored.includes(TI), "bridge_feed JSON: no words, no login");
  const vr = (await getQuery("SELECT vz, vw FROM bridge_veil WHERE c = ?", [C.tina]))[0];
  assert.equal(vr.vw, W.tina, "the words in bridge_veil");
  assert.equal(FN.current(ROOM.id, TI), null, "no frog-name session was opened for a named speaker");
  // frankie: his INCOGNITO frog name on the bar - the same as on his typed lines before and after (the session wasn't ended)
  const fr = R().feed.find((x) => x.c === C.fr);
  const frMsgs = R().feed.filter((x) => x._vz && x._vz.login === FR && x.k === "msg");
  assert.ok(ALIAS_RE.test(fr.u.alias || ""), "frankie's bar carries a frog name: " + JSON.stringify(fr.u));
  assert.equal(frMsgs.length, 2);
  for (const m of frMsgs) assert.equal(m.u.alias, fr.u.alias, "one frog name across his typed lines and his bar");
  assert.equal(fr.u.veil, "hidden");
  assert.equal(fr._vz.lv, "incognito");
  // hank: one bar
  const hk = R().feed.find((x) => x.c === C.hk);
  assert.ok(hk.mask && hk.tm === 1 && hk.u.veil === "hidden");
  // the malformed ones
  for (const w of ["malformed message words", "malformed no tx flag", "malformed tx yes"]) {
    assert.ok(!R().feed.some((x) => x._vw === w), "dropped: " + w);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil WHERE vw LIKE 'malformed%'"))[0].n, 0);
});

test("the sticky !transcripts off set never leaves the bar out - it does leave out their 🎙 lines with words, as before", async () => {
  await ready();
  assert.equal(CL.isTxHiddenHash(hash(TI)), true, "tina's transcripts are off on the site");
  assert.equal(CV.privacyOf(R().feed.find((x) => x.c === C.tina)), "mask");
  assert.equal(CV.privacyOf(R().feed.find((x) => x.c === C.fr)), "mask");
  assert.equal(CV.privacyOf(R().feed.find((x) => x.c === C.hk)), "mask");
  assert.equal(CV.privacyOf(R().feed.find((x) => x.c === C.before)), "out", "her named line from before: left out (as before)");
  // the same 🎙 line WITHOUT the stamp (an older build's, or words in it) - out
  const plain = Object.assign({}, R().feed.find((x) => x.c === C.tina));
  delete plain.tm;
  assert.equal(CV.privacyOf(plain), "out", "an unstamped hidden 🎙 line of someone with transcripts off: out, as before");
  // her typed line and her mic lines are untouched
  const lv = await live(U.mem);
  assert.ok(lv.d.feed.some((o) => o.k === "msg" && o.text === "tina typed this line" && o.u && o.u.login === TI), "her typed line, named");
  assert.ok(lv.d.feed.some((o) => o.k === "mic" && o.u && o.u.login === TI), "her mic grab, named");
});

test("every role's live view: the bar under 'someone' (frankie's under his frog name), no words, no hold / id; rv for the owner and admins only", async () => {
  await ready();
  for (const u of [U.mem, U.staff, U.own, U.adm, null]) {
    const lv = await live(u);
    assert.equal(lv.status, 200, lv.text.slice(0, 200));
    const by = new Map(lv.d.feed.map((o) => [o.c, o]));
    const t = by.get(C.tina), f = by.get(C.fr), h = by.get(C.hk);
    assert.ok(t && f && h, "the three bars are shown");
    assert.deepEqual(t.u, { anon: true, display: "someone", veil: "hidden" });
    for (const o of [t, f, h]) {
      assert.ok(/^[sml]$/.test(o.mask) && !("text" in o) && !("id" in o), "a bar: no words, no 🎙 id (no clip)");
      assert.ok(!("tm" in o), "the stamp is server-only");
    }
    assert.ok(!t.hold, "no hold beside 'someone' (her grab was named)");
    assert.ok(ALIAS_RE.test(f.u.alias || ""), "frankie's frog name");
    assert.ok(!by.get(C.before), "her earlier named 🎙 line isn't there");
    const mayReveal = u === U.own || u === U.adm;
    for (const o of [t, f, h]) assert.equal(o.rv === 1, mayReveal, `rv for ${u ? u.username : "signed out"}`);
    assert.deepEqual(leaks(lv.text).filter((x) => x !== TI), [], `nothing of the bars reaches ${u ? u.username : "a visitor"}: ` + leaks(lv.text).join(", "));
  }
});

test("see-through: admins and the pad's owner reveal the words (logged tx_line); members and staff can't; the toggle's batches log tx_line too", async () => {
  await ready();
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  for (const u of [U.mem, U.staff]) {
    const r = await call("POST", "/api/chatlog/reveal", { user: u, body: { room: SLUG, c: [C.tina] } });
    assert.equal(r.status, 403, u.username);
    assert.ok(!r.text.includes(W.tina));
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, n0, "a refusal logs nothing");
  // a hidden person's ordinary hidden line next to a transcripts bar: two rows, each with its own scope
  await sync([ev("message", { user: real(HK, "Hank"), priv: priv("hidden", HK, { words: "a plain hidden typed line" }) })]);
  await settle();
  const hkMsg = R().feed.find((x) => x._vw === "a plain hidden typed line").c;
  const a = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [C.tina, hkMsg], reason: "report 12" } });
  assert.equal(a.status, 200, a.text);
  const got = new Map(a.d.items.map((o) => [o.c, o]));
  assert.equal(got.get(C.tina).login, TI);
  assert.equal(got.get(C.tina).words, W.tina, "the admin reads what she said");
  assert.equal(got.get(hkMsg).words, "a plain hidden typed line");
  const rows = await getQuery("SELECT scope, role, logins, reason, ref FROM seethrough_log WHERE id > ? ORDER BY id", [0]);
  const tx = rows.filter((r) => r.scope === "tx_line"), cl = rows.filter((r) => r.scope === "chat_line");
  assert.equal(tx.length, 1, "one tx_line row: " + JSON.stringify(rows));
  assert.deepEqual(JSON.parse(tx[0].logins), [TI]);
  assert.equal(tx[0].role, "admin");
  assert.equal(tx[0].reason, "report 12");
  assert.equal(cl.length, 1, "the hidden line's row stays chat_line");
  assert.deepEqual(JSON.parse(cl[0].logins), [HK]);
  // the pad's owner (their era): the same, logged as the owner
  const o = await call("POST", "/api/chatlog/reveal", { user: U.own, body: { room: SLUG, c: [C.fr] } });
  assert.equal(o.status, 200, o.text);
  assert.equal(o.d.items[0].words, W.fr);
  assert.equal(o.d.items[0].login, FR);
  const ow = (await getQuery("SELECT scope, role FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([ow.scope, ow.role], ["tx_line", "owner"]);
  // the toggle: its own row counts the batch; a tx_line row says the transcripts bar was seen through
  const on = await call("POST", "/api/chatlog/seethrough", { user: U.adm, body: { room: SLUG, on: true } });
  assert.equal(on.status, 200, on.text);
  const tg = (await getQuery("SELECT id FROM seethrough_log WHERE scope = 'chat_toggle' AND ended IS NULL ORDER BY id DESC LIMIT 1"))[0];
  const b = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [C.hk], toggle: true } });
  assert.equal(b.status, 200, b.text);
  assert.equal(b.d.items[0].words, W.hk);
  const last = (await getQuery("SELECT scope, ref, logins FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([last.scope, last.ref, JSON.parse(last.logins)], ["tx_line", "toggle:" + tg.id, [HK]]);
  await call("POST", "/api/chatlog/seethrough", { user: U.adm, body: { room: SLUG, on: false } });
  // the archive path (the live ring forgot it): still tx_line
  const keep = R().feed.find((x) => x.c === C.fr);
  R().feed.splice(R().feed.indexOf(keep), 1);
  try {
    const ar = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [C.fr] } });
    assert.equal(ar.status, 200, ar.text);
    assert.equal(ar.d.items[0] && ar.d.items[0].words, W.fr, "revealed from the archive (chat_log_veil)");
    assert.equal((await getQuery("SELECT scope FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0].scope, "tx_line", "the archive's line is labelled too");
  } finally { R().feed.push(keep); R().feed.sort((x, y) => x.c - y.c); }
});

test("the speaker's own view: their words with 'only you' (self: 1); Download my data has them, marked hidden", async () => {
  await ready();
  const lv = await live(U.tina);
  const mine = lv.d.feed.find((o) => o.c === C.tina);
  assert.equal(mine.self, 1);
  assert.equal(mine.text, W.tina, "her own words");
  const others = await live(U.mem);
  assert.ok(!others.text.includes(W.tina));
  const lines = await CL.exportLines(U.tina.userId, TI);
  const row = lines.find((l) => l.kind === "mic" && l.text === W.tina);
  assert.ok(row && row.hidden === true, "her export has the bar's words, marked hidden: " + JSON.stringify(lines));
});

test("history: read in SQL, a bar for everyone (no words); search never finds it; downloads show [hidden]", async () => {
  await ready();
  const CH = require(path.join(repo, "chatloghist"));
  CH._reset();
  assert.ok(!CH.hiddenLogins("history").tx.includes("h:" + hash(TI)), "history reads her 'h:' 🎙 rows (the projection masks them)");
  assert.ok(CH.hiddenLogins("search").tx.includes("h:" + hash(TI)) || CH.hiddenLogins("search").out.includes("h:" + hash(TI)),
            "search skips them in SQL");
  const pg = await CH.page(U.mem, SLUG, { limit: 200 });
  const row = (pg.items || []).find((o) => o.c === C.tina);
  assert.ok(row && /^[sml]$/.test(row.mask) && !("text" in row), "a bar in scrollback: " + JSON.stringify(row));
  assert.ok(!(pg.items || []).some((o) => o.c === C.before), "her earlier named 🎙 line stays out");
  assert.deepEqual(leaks(JSON.stringify(pg)).filter((x) => x !== TI), []);
  const db = (await getQuery("SELECT text, who FROM chat_log WHERE c = ?", [C.tina]))[0];
  assert.equal(db.text, null, "chat_log text NULL (never indexed)");
  assert.equal(db.who, "h:" + hash(TI));
  assert.equal((await getQuery("SELECT words FROM chat_log_veil WHERE c = ?", [C.tina]))[0].words, W.tina, "the words in chat_log_veil");
  assert.deepEqual(await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ?", ['"quokkatina"']), [], "never in the index");
  const CS = require(path.join(repo, "chatlogsearch"));
  for (const u of [U.own, U.mem, U.adm]) {
    CS._reset();
    const r = await CS.search(u, SLUG, { q: "quokkatina" }).catch((e) => ({ hits: [], err: e.code }));
    assert.deepEqual(r.hits || [], [], "no hit for " + u.username);
  }
  X._reset();
  X._setLimits({ perMin: 1000 });
  for (const fmt of ["txt", "jsonl"]) {
    const r = await call("POST", `/api/rooms/${SLUG}/chatlog/export`, { user: U.adm, body: { fmt, range: "24h", sys: true } });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const f = await call("GET", r.d.url, { user: U.adm });
    assert.equal(f.status, 200);
    assert.deepEqual(leaks(f.text).filter((x) => x !== TI), [], fmt + ": " + leaks(f.text).join(", "));
    if (fmt === "txt") assert.match(f.text, /^\[\d\d:\d\d\] 🎙 someone: “\[hidden\]”$/m, "TXT: someone + [hidden]");
    else assert.ok(f.text.trim().split("\n").slice(1).map((l) => JSON.parse(l)).some((o) => o.masked === true && o.k !== "msg"), "JSONL: masked");
  }
});

test("quotes, member clips and moderation evidence: a bar is never quotable or clippable by members; evidence is offered (see-through roles)", async () => {
  await ready();
  const it = R().feed.find((x) => x.c === C.tina);
  const Q = require(path.join(repo, "quotes"));
  assert.ok(!Q.shownFeed(R().feed).includes(it), "Pepe's !quote never picks it");
  assert.ok(Q.pick(R().feed, { cs: [it.c] }).error, "nor a website selection");
  assert.notEqual(CV.privacyOf(it), "anon", "the site's 🔊 Clip takes only 'anon' (frog-name) lines - never a bar");
  const EV = require(path.join(repo, "evidence"));
  await EV.init();
  await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  try {
    assert.equal(EV.offerable(R(), C.tina), true, "a revealed bar can be saved as moderation evidence (like a hidden turn)");
    assert.equal(EV.offerable(R(), C.fr), true);
    // the evidence request itself: members can't; an admin's is logged clip_preview, its ref naming the transcripts toggle (":tx")
    const m = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.mem, body: { c: C.tina, reason: "x" } });
    assert.equal(m.status, 403, m.text);
    const a = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: C.tina, reason: "report 12" } });
    assert.equal(a.status, 200, a.text);
    const row = (await getQuery("SELECT scope, ref, logins FROM seethrough_log WHERE scope = 'clip_preview' ORDER BY id DESC LIMIT 1"))[0];
    assert.ok(row && /^evp:w[0-9a-f]{16}:tx$/.test(row.ref), "logged with :tx - " + JSON.stringify(row));
    assert.deepEqual(JSON.parse(row.logins), [TI]);
  } finally { await EV.setOn(false, { userId: U.adm.userId, username: "adm" }); }
});

// ── review fixes ──
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), crypto.randomBytes(400)]);
let app2 = null, base2 = null;
async function termsApp() {
  if (base2) return base2;
  app2 = express();
  app2.set("views", path.join(repo, "views"));
  app2.set("view engine", "ejs");
  app2.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  require(path.join(repo, "terms")).register(app2, { addUser });
  require(path.join(repo, "evidenceexport")).register(app2, { addUser, bySlug: (s) => (s === SLUG ? R() : null) });
  const srv = await new Promise((r) => { const s = app2.listen(0, () => r(s)); });
  srv.unref();
  base2 = "http://127.0.0.1:" + srv.address().port;
  return base2;
}
function get2(p, user = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(base2 + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: user ? { "x-test-user": user.userId } : {} }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString("utf8") }));
    }).on("error", reject);
  });
}
const LIVE_S = "With <code>!transcripts off</code>, your mic transcripts are kept like hidden lines";
const KEPT_S = ["<code>!transcripts off</code> leaves your mic transcripts out. The ones already shown as a blacked-out bar are kept like hidden lines: never searched or quoted, and only the pad's owner and PATV administrators can reveal what you said.",
                " <code>!transcripts off</code> leaves your mic transcripts out; the ones already shown as a blacked-out bar stay that way, and administrators and the pad's owner can reveal those too.",
                "<li><b><code>!transcripts off</code> leaves your mic transcripts out.</b> Mic turns that already show on the website as a blacked-out bar stay that way: only PATV administrators and a pad's owner (in their own pad, for lines said while they own it) can reveal what you said, and every reveal is logged.</li>",
                "(sections 3 and 10): new mic transcripts are left out of the website again; the ones already shown as a blacked-out bar stay that way.</li>"];
const LIVE_NOTE = "(sections 3 and 10): your mic transcripts now show on the website as a blacked-out bar without your name instead of being left out";
const WAVE2_S = "<code>!transcripts off</code> leaves your mic transcripts out. Lines said before";
const KEPT_HELP = "Mic turns that already show on the website as a blacked-out bar stay that way";

test("review fix F1: the bar no longer live (a Pepe without it - a rollback) while bars it made are kept: /privacy and /help say so, never just 'left out'", async () => {
  await ready();
  await termsApp();
  const H = require(path.join(repo, "help"));
  await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], txbar_cap: 1 } });
  await settle();
  assert.equal(PW.txBar(), true);
  const p1 = await get2("/privacy");
  assert.equal(p1.status, 200, p1.text.slice(0, 300));
  assert.ok(p1.text.includes(LIVE_S) && p1.text.includes(LIVE_NOTE), "live: the bar's text and its dated note");
  for (const s of KEPT_S) assert.ok(!p1.text.includes(s), "live: no kept text - " + s.slice(0, 60));
  // a rolled-back Pepe: a sync without txbar_cap; privacy wire v2 stays on - tina's / frankie's / hank's bars are still kept and revealable
  await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [] } });
  await settle(150);
  assert.equal(PW.isOn(), true);
  assert.equal(PW.txBar(), false, "the bar isn't live any more");
  const rv = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [C.fr], reason: "after rollback" } });
  assert.equal(rv.status, 200, rv.text);
  assert.equal(rv.d.items[0] && rv.d.items[0].words, W.fr, "...its bars are still revealable (why the text must say so)");
  const p2 = await get2("/privacy");
  assert.equal(p2.status, 200);
  for (const s of KEPT_S) assert.equal(p2.text.split(s).length, 2, "kept, once: " + s.slice(0, 70));
  assert.ok(p2.text.includes(LIVE_NOTE), "the dated note of when the bar started stays (history)");
  assert.ok(!p2.text.includes(LIVE_S), "no 'live' sentence (new ones are left out)");
  assert.ok(!p2.text.includes(WAVE2_S), "not wave 2's bare 'leaves your mic transcripts out' while bars are kept");
  assert.ok(p2.text.indexOf(KEPT_S[3]) < p2.text.indexOf(LIVE_NOTE), "the kept note comes first (newest)");
  const card = H.withPrivwireNotes([{ id: "transcripts", summary: "off", details: "Pepe's own words." }, { id: "dice", summary: "roll" }]);
  assert.ok(String(card[0].details).includes(KEPT_HELP), "/help: the transcripts card says the bars stay - " + card[0].details);
  assert.equal(card[1].summary, "roll", "other cards untouched");
  assert.equal(await PW.refreshTxKept(), true, "the site knows bars are still kept");
  assert.equal(PW.txText(), "kept");
  // the bar live again: the live text
  await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], txbar_cap: 1 } });
  await settle();
  assert.equal(PW.txText(), "live");
  const p3 = await get2("/privacy");
  assert.ok(p3.text.includes(LIVE_S) && !p3.text.includes(KEPT_S[0]));
});

test("review fix TXBAR-ST-2 / ST-3: the log names the transcripts toggle on every path; exports and evidence lists say 'transcripts off', not !bridge hide", async () => {
  await ready();
  await termsApp();
  const EV = require(path.join(repo, "evidence"));
  await EV.init();
  await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  try {
    // a bar whose speaker ALSO has a frog name (hank: !bridge hide + transcripts off): both toggles seen through - a row for each
    const id0 = (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM seethrough_log"))[0].m;
    const r = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [C.hk], reason: "case 31" } });
    assert.equal(r.status, 200, r.text);
    const rows = await getQuery("SELECT scope, logins FROM seethrough_log WHERE id > ? ORDER BY id", [id0]);
    assert.deepEqual(rows.map((x) => [x.scope, JSON.parse(x.logins)]), [["chat_line", [HK]], ["tx_line", [HK]]], JSON.stringify(rows));
    // the Camfrog !clipmic evidence upload of tina's bar's turn: marked (tm), its clip_save row names the toggle, the list says so
    const up = await call("POST", "/api/bridge/evidence/upload", { body: { password: "bot", room: ROOM.id, target: TI, veil: "hidden", requester: "admcf",
                                                                           said_at: Date.now() / 1000 - 60, secs: 3, tx: "tx-00000000000000b1", data: M4A.toString("base64") } });
    assert.equal(up.status, 200, up.text);
    const row = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [up.d.id]))[0];
    assert.equal(Number(row.tm), 1, "the clip of a transcripts bar's turn is marked");
    assert.equal(row.veil, "hidden", "...and gated like a hidden turn");
    const cs = (await getQuery("SELECT ref FROM seethrough_log WHERE scope = 'clip_save' ORDER BY id DESC LIMIT 1"))[0];
    assert.equal(cs.ref, "ev:" + up.d.id + ":tx", "clip_save names the transcripts toggle");
    const ls = await call("GET", "/api/evidence?room=" + SLUG, { user: U.adm });
    assert.equal(ls.status, 200, ls.text);
    const lr = (ls.d.rows || []).find((x) => x.id === up.d.id);
    assert.ok(lr && lr.tx === true && lr.veil === "hidden", "the list marks it transcripts off: " + JSON.stringify(lr));
    // the admin evidence export: tina's 🎙 line is "[hidden, transcripts off]", and a tx_line row with the export's ref names her
    const X2 = require(path.join(repo, "evidenceexport"));
    const tok = "tok" + crypto.randomBytes(8).toString("hex");
    X2._tokens.set(tok, { userId: U.adm.userId, username: "adm", roomId: ROOM.id, slug: SLUG, pad: "Txbar Room", from: Date.now() - 3 * 3600e3, to: Date.now() + 60e3,
                          fmt: "txt", reason: "case 32", cut: null, exp: Date.now() + 60e3 });
    const ex = await get2("/admin/evidence-export/dl/" + tok, U.adm);
    assert.equal(ex.status, 200, ex.text.slice(0, 300));
    assert.match(ex.text, /🎙 tinatxoff \(Tina\) \[hidden, transcripts off\]: quokkatina zebrafinch said on the mic/, "the export labels tina's bar");
    assert.ok(!/🎙 tinatxoff \(Tina\) \[hidden\]:/.test(ex.text), "never as a plain hidden (!bridge hide) line");
    const er = await getQuery("SELECT scope, ref, logins FROM seethrough_log WHERE scope IN ('export_evidence', 'tx_line') ORDER BY id DESC LIMIT 2");
    const exp = er.find((x) => x.scope === "export_evidence"), txr = er.find((x) => x.scope === "tx_line");
    assert.ok(exp && txr && txr.ref === exp.ref && JSON.parse(txr.logins).includes(TI), "a tx_line row with the export's ref: " + JSON.stringify(er));
    // an admin's per-login tool reaching tina's bars: chat_tool + tx_line
    const CM = require(path.join(repo, "chatlogmod"));
    const id1 = (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM seethrough_log"))[0].m;
    await CM.whoAction(U.adm, TI, { action: "look", why: "case 33" });
    const tr = await getQuery("SELECT scope, ref FROM seethrough_log WHERE id > ? ORDER BY id", [id1]);
    assert.deepEqual(tr.map((x) => [x.scope, x.ref]), [["chat_tool", "look"], ["tx_line", "look"]], JSON.stringify(tr));
  } finally { await EV.setOn(false, { userId: U.adm.userId, username: "adm" }); }
});

test("forget-me: the bar's identity and words leave the side tables - nobody can reveal it any more", async () => {
  await ready();
  await bridge.forgetVeiled([TI]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil WHERE c = ?", [C.tina]))[0].n, 0);
  await CL.forgetVeil([TI]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log_veil WHERE c = ?", [C.tina]))[0].n, 0);
  const r = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [C.tina] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.items, [], r.text);
});

test("review fix F1: once no bar's words and no clip of one are left, the page reads as wave 2 did again (the bar not live)", async () => {
  await ready();
  await termsApp();
  await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [] } });          // the bar not live
  await settle(150);
  await bridge.forgetVeiled([FR, HK]);
  await CL.forgetVeil([FR, HK]);
  assert.equal(await PW.refreshTxKept(), true, "an evidence clip of a bar's turn is still kept (30 days): still 'kept'");
  await runQuery("DELETE FROM evidence_clips WHERE tm = 1");                                            // (as its sweep would)
  assert.equal(await PW.refreshTxKept(), false, "none left");
  assert.equal(PW.txText(), null);
  const p = await get2("/privacy");
  assert.ok(p.text.includes(WAVE2_S), "wave 2's sentence again");
  for (const s of KEPT_S) assert.ok(!p.text.includes(s), "no kept text: " + s.slice(0, 60));
  await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], txbar_cap: 1 } });
  await settle();
});

test("review fix F2: scrollback reads only the bars of a !transcripts off person's 'h:' 🎙 rows - their other rows stay skipped in SQL", async () => {
  await ready();
  // frankie (incognito, transcripts off): 40 incognito 🎙 lines WITH words (as Pepe sends them while transcripts are on) - left out
  const evs = [];
  for (let i = 0; i < 40; i++) {
    evs.push(ev("x.pepe.transcript", { id: "tx-0000000000f" + String(i).padStart(5, "0"), user: real(FR, "Frankie"), source: "mic", said_at: Date.now() / 1000,
                                       text: "frankie incog words " + i, priv: priv("incognito", FR) }));
  }
  await sync(evs);
  await settle(200);
  const n = (await getQuery("SELECT COUNT(*) AS n FROM chat_log WHERE who = ? AND k = 'tx'", ["h:" + hash(FR)]))[0].n;
  assert.ok(n >= 40, "archived as 'h:' rows: " + n);
  const CH = require(path.join(repo, "chatloghist"));
  CH._reset();
  CV._clearCaches();
  CH._setLimits({ scanMax: 10 });
  try {
    const pg = await CH.page(U.mem, SLUG, { limit: 5 });
    assert.ok((pg.items || []).length > 0, "a page past his 40 left-out rows still has items (they weren't walked): " + JSON.stringify(Object.keys(pg)));
    assert.ok(!(pg.items || []).some((o) => /frankie incog words/.test(o.text || "")), "never shown");
  } finally { CH._reset(); }
  CV._clearCaches();
  const X1 = CH.hiddenLogins("history");
  assert.ok((X1.txb || []).includes("h:" + hash(FR)) && !X1.tx.includes("h:" + hash(FR)), "history: his 'h:' 🎙 rows are read only as bars (txb)");
  assert.match(CH.pageSql({ nTxB: 1 }), /\(who NOT IN \(\?\) OR json_extract\(d, '\$\.tm'\) = 1\)/);
});
