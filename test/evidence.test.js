// wave 2 WP-5 (incognito / mic-stage spec E.3, E.4, E.5, H, I.3 WP-5, I.4; owner J-7 + the M addenda): moderation evidence clips
// (evidence.js) and the admin evidence export (evidenceexport.js).
//   * dark: with the evidence switch off (or privacy wire v2 off) no route makes a clip (409), the sync answer never says
//     `evidence`, reveal answers carry no offer, the privacy copy is null and the sweep is a no-op on an empty table
//   * an evidence clip only with see-through: an admin anywhere, the pad's owner in their era; a member, staff, another pad's owner and
//     a signed-out visitor are refused - on the website path and the Camfrog upload alike; the role is asked before anything about
//     the line (review fix XT-3: the same 403 for every cursor - no "which are veiled turns / whose identity row is gone" oracle)
//   * Pepe's answer must be THAT login's turn at the same veil answering THIS audited request (veil_ok = its seethrough row)
//   * evidence-only for both levels: no media row, no post, no story; the pad-post / clip-data routes refuse an evidence id; a member's
//     clip of a hidden turn is refused; no other module reads the store (a source scan)
//   * visible to admins + that pad's owner only (list + audio); downloads admins only; every access a seethrough_log row (+ admin_audit
//     for what changes or copies something)
//   * 30-day expiry (file then row) except under the clip's hold or a chat legal hold; orphans and stale previews go
//   * the export: admins only, watermarked first and last, real names + hidden words, logged BEFORE the first byte, single use, no-store
//   * forget-me flags (never extends) a subject's clips; nothing logs a body, a login or the audio
//   node --test test/evidence.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
delete process.env.EVIDENCE_DIR;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "ef".repeat(32);
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
const ST = require(path.join(repo, "seethrough"));
const EV = require(path.join(repo, "evidence"));
const EX = require(path.join(repo, "evidenceexport"));
const BU = require(path.join(repo, "botupload"));

const D = 864e5;
const EVDIR = path.join(tmp, "evidence-store");
const BUDIR = path.join(tmp, "uploads", ".botupload");
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Ev.Room", name: "Evidence Room" }, SLUG = "evidence-room";
const OTHER = { id: "EvOther.Room", name: "Evidence Other" };
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (type, data, ts = Date.now(), room = ROOM) => ({ op: "event", id: "ev-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
const sync = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [], bridge_hidden_h: [], incog_hidden_h: [] }, extra), { v2: true });
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), crypto.randomBytes(400)]);
const HIDDEN_WORDS = "the hidden sentence about the stolen bike";
const MARK = "MARKER-" + crypto.randomBytes(4).toString("hex");
// the shared wire fixture (camfrog-bot tools/gen_evidence_wire.py writes it from pepe_micclip's real builders; byte-identical with the
// bot's ci/fixtures/evidence-wire.json). Update together with its pin there (evidence_wire_test.py PIN).
const WIRE_PIN = "84a7b57fe089c963765d25d9c1c0012bda2d8f8569bb7f87ac6322020ee9ed65";
const WIRE_RAW = fs.readFileSync(path.join(__dirname, "fixtures", "evidence-wire.json"));

function call(method, url, { user = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks), s = buf.toString("utf8");
        let d = null; try { d = JSON.parse(s); } catch (e) { d = null; }
        resolve({ status: res.statusCode, d, text: s, buf, headers: res.headers });
      });
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
const R0 = () => bridge._rooms.get(ROOM.id);
const txLine = (login) => R0().feed.filter((x) => x.k === "tx" && x._vz && x._vz.login === login).slice(-1)[0];
const scopeRows = async (scope) => getQuery("SELECT * FROM seethrough_log WHERE scope = ? ORDER BY id", [scope]);
const auditRows = async (action) => getQuery("SELECT * FROM admin_audit WHERE action = ? ORDER BY id", [action]);
const resetLimits = () => { for (const k of [...relay._hits.keys()]) if (String(k).startsWith("evidence|")) relay._hits.delete(k); };
/** Pepe's answer to an evidence job (the bot-token route), from the job the site queued */
const answer = (job, over = {}) => call("POST", "/api/bridge/evidence", { body: Object.assign({ password: "bot", id: job.id, state: "ok", data: M4A.toString("base64"), secs: 4,
  target: job.target, veil: job.veil, veil_ok: job.veil_ok }, over) });
async function freshLines() {
  // fresh 🎙 lines inside Pepe's 15 minutes (a test may run late in the file)
  const n = ++seq;
  await sync([
    ev("x.pepe.transcript", { id: "tx-" + ("a" + n).padStart(16, "0"), user: real("frankiefettuccine", "Frankie Fett"), text: "an incognito turn " + n, source: "mic",
                              said_at: Date.now() / 1000 - 3, priv: priv("incognito", "frankiefettuccine") }),
    ev("x.pepe.transcript", { id: "tx-" + ("b" + n).padStart(16, "0"), user: real("hankhidden", "Hank Hide"), source: "mic", said_at: Date.now() / 1000 - 2,
                              priv: priv("hidden", "hankhidden", { words: HIDDEN_WORDS }) }),
    ev("x.pepe.transcript", { id: "tx-" + ("c" + n).padStart(16, "0"), user: real("alicecf", "Alice"), text: "a named turn " + n, source: "mic", said_at: Date.now() / 1000 - 1 }),
  ]);
  await settle();
  return { fr: txLine("frankiefettuccine"), hk: txLine("hankhidden"), al: R0().feed.filter((x) => x.k === "tx" && x.u && x.u.login === "alicecf").slice(-1)[0] };
}
/** The website path, all the way: reveal-free request -> Pepe answers -> save. -> {id, job, preview} */
async function saveVia(user, it, { reason = "the report" } = {}) {
  resetLimits();
  const r = await call("POST", `/api/rooms/${SLUG}/evidence`, { user, body: { c: it.c, reason } });
  assert.equal(r.status, 200, r.text);
  const job = relay._jobs.get(r.d.id);
  const a = await answer(job);
  assert.equal(a.status, 200, a.text);
  const s = await call("POST", `/api/rooms/${SLUG}/evidence/${r.d.id}/save`, { user, body: { reason } });
  assert.equal(s.status, 200, s.text);
  return { id: s.d.id, job, preview: r.d.id, expires_at: s.d.expires_at };
}

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.own2 = await mkUser("own2", "pleb", "own2cf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.staff = await mkUser("helper", "Staff", "helpercf");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.adm2 = await mkUser("adm2", "Admin", "adm2cf");
  await rooms.init();
  const app = express();
  app.use((req, res, next) => (["/api/bridge/sync", "/api/bridge/sync/v2", "/api/bridge/evidence", "/api/bridge/evidence/upload", "/api/bridge/micclip",
                                "/api/bot/upload/chunk", "/api/bot/upload/finish"].includes(req.path)
    ? next() : express.json()(req, res, next)));
  BU._setDir(BUDIR);
  BU.register(app, { isBotToken: (t) => t === "bot", noTimers: true });     // (index.js: Pepe's bodies over 700 KB come in chunks)
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
  EV._setDir(EVDIR);
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  await rooms.setOwner(ROOM.id, "own", "test");
  await rooms.setOwner(OTHER.id, "own2", "test").catch(() => {});
  await sync([], { rooms: [{ room: ROOM, members: [real("alicecf", "Alice"), Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), src: "list" }),
                                                  Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden"), src: "list" })],
                              mic: [], count: 4, transcripts: true }] });
  await sync([], { rooms: [{ room: OTHER, members: [real("bobcf", "Bob")], mic: [], count: 1 }] });
  await sync([ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "pizza time", priv: priv("incognito", "frankiefettuccine") })]);
  await settle();
  await CV.init();
  CV._clearCaches();
  await EV.init();
})();

test("dark: switch off -> no clip anywhere (409), no sync advert, no offer on reveals, no privacy copy; ON is refused while privacy wire v2 is off", async () => {
  await setup;
  const { hk } = await freshLines();
  assert.equal(EV.isOn(), false, "ships off");
  assert.equal(EV.effective(), false);
  const sa = await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [] } });
  assert.equal(sa.status, 200);
  assert.ok(!("evidence" in sa.d), "the sync answer never says evidence while off");
  const r = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: hk.c } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.d.code, "evidence_off");
  const up = await call("POST", "/api/bridge/evidence/upload", { body: { password: "bot", room: ROOM.id, target: "hankhidden", veil: "hidden", requester: "admcf",
                                                                         said_at: Date.now() / 1000, secs: 2, data: M4A.toString("base64") } });
  assert.equal(up.status, 409, "Camfrog uploads too");
  const rv = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [hk.c] } });
  assert.equal(rv.status, 200, rv.text);
  assert.ok(rv.d.items[0] && !("ev" in rv.d.items[0]), "no evidence offer while off");
  assert.equal(await EV.privacyCopy(), null, "the privacy page reads as before");
  // review fix WP5-ACC-1 / R3 / WP5-T1: the admin evidence export is dark too - refused before any link, any log row, any file
  const ex0 = await call("POST", "/api/admin/evidence-export", { user: U.adm, body: { room: SLUG, from: Date.now() - 3600e3, to: Date.now(), fmt: "txt", reason: "report #1" } });
  assert.equal(ex0.status, 409, ex0.text);
  assert.equal(ex0.d.code, "evidence_off");
  assert.equal(EX._tokens.size, 0, "no link minted");
  assert.equal((await scopeRows("export_evidence")).length, 0, "nothing logged");
  assert.equal((await call("POST", "/api/admin/evidence-export", { user: U.staff, body: { room: SLUG, from: 1, to: 2, fmt: "txt", reason: "xyz" } })).status, 403, "staff: 403 as ever");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n, 0);
  assert.deepEqual(await EV.sweep(), { deleted: 0, held: 0, pending: 0, orphans: 0, failed: 0 }, "the sweep: a no-op on an empty table");
  // the admin switch: refused ON while privacy wire v2 is off
  await PW.setOn(false, { userId: U.adm.userId, username: "adm" });
  await assert.rejects(() => EV.setOn(true, { userId: U.adm.userId, username: "adm" }), (e) => e.code === "privwire_off");
  const sw = await call("POST", "/api/admin/evidence", { user: U.adm, body: { on: true } });
  assert.equal(sw.status, 409, "the route says so too");
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  const st = await call("POST", "/api/admin/evidence", { user: U.staff, body: { on: true } });
  assert.equal(st.status, 403, "staff can't flip it");
  const on = await call("POST", "/api/admin/evidence", { user: U.adm, body: { on: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.d.effective, true);
  assert.equal((await auditRows("evidence.switch")).length, 1, "the flip is audited");
  const sa2 = await call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [] } });
  assert.equal(sa2.d.evidence, 1, "the sync answer advertises evidence now");
});

test("an evidence clip only with see-through: member, staff, another pad's owner and signed-out are refused; reveals offer it only on veiled 🎙 lines", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const { fr, hk, al } = await freshLines();
  for (const [who, code] of [[U.mem, 403], [U.staff, 403], [U.own2, 403], [null, 401]]) {
    resetLimits();
    const r = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: who, body: { c: hk.c } });
    assert.equal(r.status, code, (who ? who.username : "signed out") + ": " + r.text);
  }
  resetLimits();
  assert.equal((await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: al.c } })).status, 404, "a named turn is no evidence clip (members clip it)");
  const msg = R0().feed.find((x) => x.k === "msg" && x._vz);
  resetLimits();
  assert.equal((await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: msg.c } })).status, 404, "a chat line has no audio");
  // cross-site / non-fetch is refused before anything
  resetLimits();
  assert.equal((await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: hk.c }, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await scopeRows("clip_preview")).length, 0, "no refused request wrote an audit row");
  // the offer: ev: 1 on a revealed veiled 🎙 line only
  const rv = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [fr.c, hk.c, msg.c] } });
  assert.equal(rv.status, 200, rv.text);
  const by = new Map(rv.d.items.map((o) => [o.c, o]));
  assert.equal(by.get(fr.c).ev, 1, "incognito 🎙: offered");
  assert.equal(by.get(hk.c).ev, 1, "hidden 🎙: offered");
  assert.ok(!("ev" in by.get(msg.c)), "a chat line: not offered");
  const ro = await call("POST", "/api/chatlog/reveal", { user: U.own, body: { room: SLUG, c: [hk.c] } });
  assert.equal(ro.d.items[0].ev, 1, "the pad's owner in their era: offered");
});

test("the website path: preview (audited) -> Pepe's audited answer -> save in ONE tx (row + clip_save + admin_audit); owner too; never posted", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const { fr, hk } = await freshLines();
  resetLimits();
  const r = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: hk.c, reason: "report #12" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers["cache-control"], "private, no-store");
  const job = relay._jobs.get(r.d.id);
  assert.ok(job && job.kind === "micevidence" && job.target === "hankhidden" && job.veil === "hidden" && job.tx === hk.id, "the job");
  assert.ok(!relay.mineFor(U.adm.userId, ROOM.id).some((j) => j.kind === "micevidence"), "never in the live view's relay list (the card polls its own route)");
  const pv = (await scopeRows("clip_preview")).slice(-1)[0];
  assert.ok(pv && pv.user_id === U.adm.userId && JSON.parse(pv.logins)[0] === "hankhidden" && pv.reason === "report #12", "clip_preview logged BEFORE Pepe is asked");
  assert.equal(job.veil_ok, pv.id, "veil_ok = that seethrough row");
  assert.ok((await auditRows("evidence.preview")).length >= 1, "admin_audit evidence.preview");
  const offered = relay.takeJobs(new Set([ROOM.id])).find((j) => j.id === job.id);
  assert.ok(offered && offered.kind === "micevidence" && offered.veil_ok === pv.id && offered.target === "hankhidden" && offered.tx === hk.id && offered.veil === "hidden",
            "Pepe's job carries target, tx, veil and veil_ok");
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((j) => j.id === job.id).length, 0, "offered once");
  // Pepe's answer must match the audited request
  for (const bad of [{ veil_ok: pv.id + 1 }, { target: "someoneelse" }, { veil: "incognito" }, { data: Buffer.from("not audio at all, no ftyp header here......................").toString("base64") }]) {
    const p = EV._pending.get(r.d.id);
    p.state = "pending"; p.ts = Date.now();
    const a = await answer(job, bad);
    assert.equal(a.status, 200);
    assert.equal(EV._pending.get(r.d.id).state, "failed", "refused: " + JSON.stringify(Object.keys(bad)));
  }
  const p = EV._pending.get(r.d.id);
  p.state = "pending"; p.ts = Date.now();
  assert.equal((await call("POST", "/api/bridge/evidence", { body: { password: "nope", id: job.id, state: "ok" } })).status, 403, "bot token only");
  assert.equal((await answer(job)).status, 200);
  const st = await call("GET", `/api/rooms/${SLUG}/evidence/${r.d.id}`, { user: U.adm });
  assert.equal(st.d.state, "ready");
  assert.equal((await call("GET", `/api/rooms/${SLUG}/evidence/${r.d.id}`, { user: U.own })).status, 404, "a preview is the requester's alone");
  const au = await call("GET", st.d.audio, { user: U.adm });
  assert.equal(au.status, 200);
  assert.match(au.headers["content-type"], /^audio\/mp4/);
  assert.match(au.headers["cache-control"], /no-store/);
  assert.equal(au.headers["x-robots-tag"], "noindex, noarchive");
  assert.equal(au.headers["cross-origin-resource-policy"], "same-origin");
  assert.ok(!au.headers.etag, "no ETag");
  assert.ok(au.buf.equals(M4A), "Pepe's bytes");
  assert.equal((await call("GET", st.d.audio, { user: U.mem })).status, 404);
  const s = await call("POST", `/api/rooms/${SLUG}/evidence/${r.d.id}/save`, { user: U.adm, body: { reason: "report #12" } });
  assert.equal(s.status, 200, s.text);
  assert.match(s.d.id, /^ev[a-f0-9]{16}$/);
  const row = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [s.d.id]))[0];
  assert.ok(row, "the row");
  assert.equal(row.subject_login, "hankhidden");
  assert.equal(row.veil, "hidden");
  assert.equal(row.room_id, ROOM.id);
  assert.equal(row.by_user, U.adm.userId);
  assert.equal(row.role, "admin");
  assert.equal(row.via, "web");
  assert.equal(Number(row.expires_at) - Number(row.created), 30 * D, "+30 days");
  assert.equal(row.sha256, crypto.createHash("sha256").update(M4A).digest("hex"));
  assert.ok(!Object.keys(row).some((k) => /text|words|transcript/.test(k)), "no transcript / hidden words column");
  const f = EV.filePath(row.file, EVDIR);
  assert.ok(f.startsWith(EVDIR) && fs.existsSync(f) && fs.readFileSync(f).equals(M4A), "in the private store");
  assert.ok(!fs.existsSync(path.join(EVDIR, "pending", r.d.id + ".m4a")), "the preview file moved");
  const saveRow = (await scopeRows("clip_save")).slice(-1)[0];
  assert.equal(saveRow.ref, "ev:" + s.d.id);
  assert.equal(row.st_id, saveRow.id, "the row names its seethrough row");
  assert.ok((await auditRows("evidence.save")).some((a) => JSON.parse(a.detail).id === s.d.id), "admin_audit evidence.save");
  // the owner, on an incognito turn in their era (and the E.6 count)
  const o = await saveVia(U.own, fr);
  const orow = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [o.id]))[0];
  assert.equal(orow.role, "owner");
  assert.equal(orow.veil, "incognito");
  // evidence-only: nothing became a post, a story or a media row
  for (const t of ["media", "feed_posts", "feed_voices"]) {
    const has = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length;
    if (has) assert.equal((await getQuery(`SELECT COUNT(*) AS n FROM ${t}`))[0].n, 0, t + ": nothing");
  }
});

test("evidence-only: the post / clip-data / audio routes refuse an evidence id; a member's clip of a hidden turn is refused; nothing in any page", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const { hk } = await freshLines();
  const saved = await saveVia(U.adm, hk);
  // Pepe's publish paths take media ids / preview ids, never evidence: an evidence id (and its preview id) gets nothing
  const post = await call("POST", "/api/bridge/micclip/post", { body: { password: "bot", media: saved.id, by: "admcf", speakers: ["hankhidden"], caption: "x" } });
  assert.equal(post.status, 404, "no pad post of an evidence clip");
  for (const id of [saved.id, saved.preview]) {
    const cd = await call("POST", "/api/bridge/micclipdata", { body: { password: "bot", id, user: "adm" } });
    assert.equal(cd.status, 404, "micclipdata: " + id);
    assert.equal((await call("GET", `/api/rooms/${SLUG}/micclip/${id}/audio`, { user: U.adm })).status, 404, "the clip preview route: " + id);
  }
  // a member's 🔊 Clip of the hidden turn: the usual refusal (J-7 as confirmed)
  R0().clipOn = true;
  const mc = await call("POST", `/api/rooms/${SLUG}/micclip`, { user: U.mem, body: { tx: hk.id || "tx-0000000000000000" } });
  assert.equal(mc.status, 403);
  assert.equal(mc.d.code, "not_quotable");
  // no page names the clip: the live view (members, the owner, an admin) carries no evidence id, path or flag
  CV._clearCaches();
  for (const u of [U.mem, U.own, U.adm]) {
    const lv = await call("GET", `/api/rooms/${SLUG}/live`, { user: u });
    assert.equal(lv.status, 200);
    assert.ok(!lv.text.includes(saved.id) && !lv.text.includes("/api/evidence") && !/"ev":/.test(lv.text), "live view: " + u.username);
  }
});

test("the store: no module but evidence.js (and its rollback tool / lifecycle hooks) reads it - never media, stories, soundboards, voice, search, sitemaps", () => {
  const skip = new Set(["node_modules", "test", ".git", "public", "views", "docs", "discord-bot", "twitchbot", "discordself"]);
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (skip.has(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p); } };
  walk(repo);
  const rel = (f) => path.relative(repo, f).replace(/\\/g, "/");
  const table = files.filter((f) => /evidence_clips/.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
  assert.deepEqual(table, ["accountMerge.js", "accountdelete.js", "deploy/keep-staging-tables.js", "evidence.js", "loginrekey.js", "padrekey.js", "tools/evidence-purge.js"].sort(),
                   "evidence_clips: only the store, its rollback tool and the lifecycle / coverage lists");
  const req = files.filter((f) => /require\(\s*["']\.\/evidence["']\s*\)/.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
  assert.deepEqual(req, ["accountdelete.js", "adminweb.js", "bridge.js", "evidenceexport.js", "padsettings.js", "pepeforget.js", "seethrough.js", "terms.js"].sort(),
                   "require('./evidence'): the advert, the reveal offer, the policy copy, the owner card, the lifecycle hooks and the export's switch (the export and its admin form) only");
  const dir = files.filter((f) => /EVIDENCE_DIR/.test(fs.readFileSync(f, "utf8"))).map(rel).sort();
  assert.deepEqual(dir, ["evidence.js", "tools/evidence-purge.js"], "the directory");
  for (const m of ["media.js", "storykeep.js", "stories.js", "soundboards.js", "voiceclone.js", "voicestore.js", "search.js", "micclip.js", "feedstore.js", "crawlers.js"]) {
    if (fs.existsSync(path.join(repo, m))) assert.ok(!/evidence\.js|require\(["']\.\/evidence|evidence_clips/.test(fs.readFileSync(path.join(repo, m), "utf8")), m + " never touches the store");
  }
});

test("visible to admins + that pad's owner only: list and audio; downloads admins only; every access logged", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const { hk } = await freshLines();
  const saved = await saveVia(U.adm, hk);
  const list = (u, q = "") => call("GET", "/api/evidence" + q, { user: u });
  const a = await list(U.adm);
  assert.equal(a.status, 200);
  assert.ok(a.d.rows.some((r) => r.id === saved.id && r.subject === "hankhidden" && r.hold === null), "admins: every pad");
  const listRows = await scopeRows("clip_list");
  assert.ok(listRows.length >= 1 && JSON.parse(listRows.slice(-1)[0].logins).includes("hankhidden"), "a list that names subjects is logged");
  const o = await list(U.own, "?room=" + SLUG);
  assert.equal(o.status, 200, o.text);
  assert.ok(o.d.rows.some((r) => r.id === saved.id) && o.d.rows.every((r) => r.room_id === ROOM.id && !("hold" in r)), "the owner: their pad (no hold details)");
  for (const [u, q] of [[U.mem, "?room=" + SLUG], [U.staff, "?room=" + SLUG], [U.own2, "?room=" + SLUG], [U.own, ""], [U.mem, ""], [U.staff, ""]]) {
    const r = await list(u, q);
    assert.equal(r.status, 403, `${u.username} ${q}`);
    assert.ok(!r.text.includes("hankhidden"));
  }
  const o2 = await list(U.own2, "?room=" + OTHER.id);
  assert.ok(o2.status === 403 || (o2.status === 200 && !o2.text.includes("hankhidden")), "another pad's owner: their own pad only - never this pad's clips");
  assert.equal((await list(null)).status, 401);
  const audio = "/api/evidence/" + saved.id + "/audio";
  for (const u of [U.mem, U.staff, U.own2, null]) assert.equal((await call("GET", audio, { user: u })).status, 404, (u ? u.username : "signed out") + ": the same answer as no clip");
  const before = (await scopeRows("clip_play")).length;
  const p1 = await call("GET", audio, { user: U.own });
  assert.equal(p1.status, 200);
  assert.ok(p1.buf.equals(M4A));
  assert.match(p1.headers["content-disposition"], /^inline/);
  assert.match(p1.headers["cache-control"], /private, no-store/);
  await call("GET", audio, { user: U.own, headers: { range: "bytes=0-99" } });
  assert.equal((await scopeRows("clip_play")).length, before + 1, "one clip_play per viewer per clip per hour (Range requests don't add rows)");
  assert.equal((await call("GET", audio + "?dl=1", { user: U.own })).status, 403, "downloads: admins only");
  const dl = await call("GET", audio + "?dl=1", { user: U.adm });
  assert.equal(dl.status, 200);
  assert.match(dl.headers["content-disposition"], /^attachment; filename="patv-evidence-ev[a-f0-9]{16}\.m4a"/);
  assert.ok((await scopeRows("clip_download")).some((r) => r.ref === "ev:" + saved.id), "clip_download logged");
  assert.ok((await auditRows("evidence.download")).length >= 1, "and audited");
  // hold / delete: admins only, with a reason, each logged
  const h0 = await call("POST", `/api/evidence/${saved.id}/hold`, { user: U.own, body: { on: true, why: "keep it" } });
  assert.equal(h0.status, 403, "owners can't hold");
  assert.equal((await call("POST", `/api/evidence/${saved.id}/hold`, { user: U.adm, body: { on: true, why: "x" } })).status, 400, "a reason");
  const h1 = await call("POST", `/api/evidence/${saved.id}/hold`, { user: U.adm, body: { on: true, why: "court order 7" } });
  assert.equal(h1.status, 200, h1.text);
  assert.ok((await scopeRows("clip_hold")).some((r) => r.ref === "hold:" + saved.id && r.reason === "court order 7"));
  assert.equal((await auditRows("evidence.hold")).length >= 1, true);
  const d0 = await call("POST", `/api/evidence/${saved.id}/delete`, { user: U.staff, body: { why: "nope" } });
  assert.equal(d0.status, 403);
  const d1 = await call("POST", `/api/evidence/${saved.id}/delete`, { user: U.adm, body: { why: "asked by the owner" } });
  assert.equal(d1.status, 200, d1.text);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips WHERE id = ?", [saved.id]))[0].n, 0);
  assert.ok((await scopeRows("clip_delete")).some((r) => r.ref === "del:" + saved.id));
  assert.ok((await auditRows("evidence.delete")).length >= 1);
});

test("30 days: the sweep deletes file then row - except under the clip's hold or a chat legal hold (pad or person); orphans and stale previews go", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  await runQuery("DELETE FROM evidence_clips");
  const { fr, hk } = await freshLines();
  const plain = await saveVia(U.adm, fr);
  const clipHeld = await saveVia(U.adm2, fr);
  const whoHeld = await saveVia(U.own, hk);
  await runQuery("UPDATE evidence_clips SET hold_at = ?, hold_by = ?, hold_why = 'case 1' WHERE id = ?", [Date.now(), U.adm.userId, clipHeld.id]);
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, ?, ?, ?)", ["who:hankhidden", U.adm.userId, "legal request", Date.now()]);
  const fileOf = async (id) => EV.filePath((await getQuery("SELECT file FROM evidence_clips WHERE id = ?", [id]))[0].file, EVDIR);
  const fPlain = await fileOf(plain.id);
  assert.deepEqual((await EV.sweep(Date.now() + 29 * D)).deleted, 0, "day 29: nothing");
  const r = await EV.sweep(Date.now() + 31 * D);
  assert.equal(r.deleted, 1, "day 31: the unheld clip");
  assert.equal(r.held, 1, "the chat-held one kept (the clip-held one never comes up)");
  assert.ok(!fs.existsSync(fPlain), "its file went");
  const left = (await getQuery("SELECT id FROM evidence_clips")).map((x) => x.id).sort();
  assert.deepEqual(left, [clipHeld.id, whoHeld.id].sort());
  // a room hold keeps it too; releasing every hold lets the next sweep take it
  await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:hankhidden'");
  const rk = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [ROOM.id]))[0].rk;
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, ?, ?, ?)", ["room:" + rk, U.adm.userId, "room case", Date.now()]);
  assert.equal((await EV.sweep(Date.now() + 32 * D)).deleted, 0, "a room hold keeps both");
  await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["room:" + rk]);
  assert.equal((await EV.sweep(Date.now() + 33 * D)).deleted, 1, "the who-held one goes once released");
  const un = await call("POST", `/api/evidence/${clipHeld.id}/hold`, { user: U.adm, body: { on: false, why: "case closed" } });
  assert.equal(un.status, 200);
  assert.equal((await EV.sweep(Date.now() + 34 * D)).deleted, 1, "an unheld expired clip goes at the next sweep");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n, 0);
  // an orphan file (no row) older than an hour goes; a fresh one stays; a stale preview goes
  const sh = path.join(EVDIR, "ab");
  fs.mkdirSync(sh, { recursive: true });
  const orphan = path.join(sh, "ab" + "0".repeat(30) + ".m4a");
  fs.writeFileSync(orphan, M4A);
  const old = (Date.now() - 2 * 3600e3) / 1000;
  fs.utimesSync(orphan, old, old);
  const stale = path.join(EVDIR, "pending", "w" + "1".repeat(16) + ".m4a");
  fs.writeFileSync(stale, M4A);
  fs.utimesSync(stale, old, old);
  const s2 = await EV.sweep();
  assert.ok(s2.orphans >= 1 && !fs.existsSync(orphan), "orphan gone");
  assert.ok(!fs.existsSync(stale), "stale preview gone");
});

test("Camfrog !clipmic: Pepe uploads; the site maps the requester to their account and checks the same right; PM text only from the site's answer", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const up = (over) => call("POST", "/api/bridge/evidence/upload", { body: Object.assign({ password: "bot", room: ROOM.id, target: "hankhidden", veil: "hidden",
                                                                                            requester: "admcf", said_at: Date.now() / 1000 - 5, secs: 3, tx: "tx-00000000000000ff",
                                                                                            data: M4A.toString("base64") }, over) });
  assert.equal((await up({ password: "x" })).status, 403);
  const a = await up({});
  assert.equal(a.status, 200, a.text);
  assert.equal(a.d.url, "/admin/bridge#evidence");
  const row = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [a.d.id]))[0];
  assert.ok(row && row.via === "camfrog" && row.role === "admin" && row.by_user === U.adm.userId && row.reason === "Camfrog !clipmic");
  assert.ok((await scopeRows("clip_save")).some((r) => r.ref === "ev:" + a.d.id && r.reason === "Camfrog !clipmic"));
  await settle(5);
  const o = await up({ requester: "owncf", said_at: Date.now() / 1000 });           // (a turn said in the owner's era)
  assert.equal(o.status, 200, o.text);
  assert.match(o.d.url, /^\/p\/[^/]+\/settings\?tab=chat#evidence$/);
  for (const who of ["memcf", "helpercf", "own2cf", "nobodycf"]) assert.equal((await up({ requester: who })).status, 403, who);
  assert.equal((await up({ requester: "owncf", room: OTHER.id, said_at: Date.now() / 1000 })).status, 403, "the owner of another pad");
  assert.equal((await up({ requester: "owncf", said_at: 1000 })).status, 403, "a turn before the owner's era");
  assert.equal((await up({ data: Buffer.from("x".repeat(80)).toString("base64") })).status, 400, "not audio");
  assert.equal((await up({ veil: "named" })).status, 400);
});

test("nothing logs a body, a login or the audio (a marker in every field of Pepe's bodies)", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const lines = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(keep)) console[k] = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    await call("POST", "/api/bridge/evidence/upload", { body: { password: "bot", room: ROOM.id, target: "hankhidden", veil: "hidden", requester: "admcf",
                                                                said_at: Date.now() / 1000, secs: 2, reason: MARK, data: M4A.toString("base64") } });
    await call("POST", "/api/bridge/evidence/upload", { body: { password: "bot", room: ROOM.id, target: MARK, veil: "hidden", requester: MARK, said_at: 5, data: MARK } });
    await new Promise((resolve) => {
      const u = new URL(base + "/api/bridge/evidence/upload");
      const raw = `{"password":"bot","target":"${MARK}", broken json ${MARK}`;
      const rq = http.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw) } }, (res) => { res.resume(); res.on("end", resolve); });
      rq.end(raw);
    });
    await call("POST", "/api/bridge/evidence", { body: { password: "bot", id: "w" + "2".repeat(16), state: "ok", target: MARK, data: MARK } });
  } finally { Object.assign(console, keep); }
  const all = lines.join("\n");
  for (const x of [MARK, "hankhidden", "admcf", M4A.toString("base64").slice(0, 40)]) assert.ok(!all.includes(x), "never in a log line: " + x);
});

test("the export: admins only; watermarked first and last; real names + hidden words; left-out lines stay out; logged BEFORE the file; single use; no-store", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const { hk } = await freshLines();
  await sync([ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words: "words of a line taken down" }) })]);
  await settle();
  const down = R0().feed.filter((x) => x.k === "msg" && x._vz && x._vw === "words of a line taken down").slice(-1)[0];
  // a moderator's takedown: the archive row gets rm_at, the live line leaves (chatlogmod's two halves)
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = ?, rm_why = 'report' WHERE c = ?", [Date.now(), U.adm.userId, down.c]);
  await bridge.takeDown(ROOM.id, [down.c]);
  const from = Date.now() - 3600e3, to = Date.now() + 60e3;
  const ask = (u, over = {}) => call("POST", "/api/admin/evidence-export", { user: u, body: Object.assign({ room: SLUG, from, to, fmt: "txt", reason: "report #99" }, over) });
  for (const u of [U.mem, U.staff, U.own, null]) assert.equal((await ask(u)).status, 403, (u ? u.username : "signed out"));
  assert.equal((await ask(U.adm, { reason: "x" })).status, 400, "a reason");
  assert.equal((await ask(U.adm, { fmt: "html" })).status, 400, "txt or jsonl");
  const r = await ask(U.adm);
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers["cache-control"], /no-store/);
  assert.equal((await call("GET", r.d.url, { user: U.adm2 })).status, 404, "another admin can't use it");
  const r2 = await ask(U.adm);
  const before = (await scopeRows("export_evidence")).length;
  const f = await call("GET", r2.d.url, { user: U.adm });
  assert.equal(f.status, 200, f.text.slice(0, 200));
  assert.match(f.headers["content-disposition"], /^attachment; filename="patv-evidence-.+\.txt"$/);
  assert.match(f.headers["cache-control"], /private, no-store/);
  assert.equal(f.headers["x-robots-tag"], "noindex");
  const lines = f.text.trim().split("\n");
  assert.match(lines[0], /^Evidence export by adm, \d{4}-\d{2}-\d{2}T[\d:.]+Z, Evidence Room$/, "the watermark first");
  assert.equal(lines[lines.length - 1], lines[0], "and last");
  assert.ok(f.text.includes("hankhidden (Hank Hide) [hidden as "), "the hidden speaker's real name");
  assert.ok(f.text.includes(HIDDEN_WORDS), "and their words");
  assert.ok(f.text.includes("frankiefettuccine (Frankie Fett) [incognito as "), "the incognito speaker's real name");
  assert.ok(!f.text.includes("words of a line taken down"), "a taken-down line stays out");
  assert.match(f.text, /removed [1-9]/, "and is counted");
  const logged = await scopeRows("export_evidence");
  assert.equal(logged.length, before + 1, "one export_evidence row");
  const lg = JSON.parse(logged.slice(-1)[0].logins);
  assert.ok(lg.indexOf("hankhidden") >= 0 && lg.indexOf("frankiefettuccine") >= 0, "every revealed login in it");
  assert.ok(lg.indexOf("hankhidden") < lg.indexOf("alicecf") || lg.indexOf("alicecf") < 0, "the veiled ones first");
  assert.ok((await auditRows("evidence.export")).length >= 1, "admin_audit evidence.export");
  assert.equal((await call("GET", r2.d.url, { user: U.adm })).status, 404, "single use");
  // JSONL: the header's watermark, a line per row, the footer
  const j = await ask(U.adm, { fmt: "jsonl" });
  const jf = await call("GET", j.d.url, { user: U.adm });
  const rows = jf.text.trim().split("\n").map((x) => JSON.parse(x));
  assert.equal(rows[0].format, "patv-evidence/1");
  assert.match(rows[0].watermark, /^Evidence export by adm, /);
  assert.equal(rows[rows.length - 1].footer, rows[0].watermark);
  assert.ok(rows.some((o) => o.login === "hankhidden" && o.veil === "hidden" && o.text === HIDDEN_WORDS && o.kind === "mic"), "a hidden 🎙 line with its words");
  void hk;
});

test("forget-me of the subject flags their clips (never extends them); a preview of theirs waiting for Save goes", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  const { fr } = await freshLines();
  const saved = await saveVia(U.adm, fr);
  const exp0 = (await getQuery("SELECT expires_at FROM evidence_clips WHERE id = ?", [saved.id]))[0].expires_at;
  resetLimits();
  const { fr: fr2 } = await freshLines();
  const pend = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm2, body: { c: fr2.c } });
  assert.equal(pend.status, 200, pend.text);
  await require(path.join(repo, "pepeforget")).fromBot("frankiefettuccine");
  const row = (await getQuery("SELECT subject_gone_at, expires_at FROM evidence_clips WHERE id = ?", [saved.id]))[0];
  assert.ok(row.subject_gone_at > 0, "flagged");
  assert.equal(row.expires_at, exp0, "never extended");
  assert.ok(!EV._pending.has(pend.d.id), "the waiting preview went");
});

test("the UI: the pad-settings card is the OWNER's only (never staff, admins use /admin/bridge); the pad page offers Save only on ev: 1", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  assert.ok(await EV.padCard(ROOM.id, U.own), "the owner");
  for (const u of [U.staff, U.mem, U.adm, U.own2, null]) assert.equal(await EV.padCard(ROOM.id, u), null, u ? u.username : "signed out");
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /if \(o\.ev === 1 && window\.PATVPadEvidence/, "the Save button only on an ev: 1 reveal answer");
  assert.match(room, /\/public\/js\/pad-evidence\.js\?v=\d+/);
  const ps = fs.readFileSync(path.join(repo, "views", "padSettings.ejs"), "utf8");
  assert.match(ps, /<% if \(typeof evidence !== 'undefined' && evidence\) \{ %>[\s\S]{0,200}id="evidence"/, "the card renders only with padCard's answer");
  assert.match(fs.readFileSync(path.join(repo, "padsettings.js"), "utf8"), /evidence: camfrog && !R\.profile \? await require\("\.\/evidence"\)\.padCard\(R\.id, viewer\)/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "pad-evidence.js"), "utf8");
  assert.ok(!/innerHTML/.test(js), "textContent only");
  const adm = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.match(adm, /<% if \(_can\('chatlog\.see_through'\)\) \{ %>\s*<section class="adm-card" id="evidence"/, "the admin card: see-through admins only");
  assert.match(adm, /<% if \(locals\.evExport\) \{ %>\s*<form id="exForm"/, "review fix WP5-ACC-1: the export form only while evidence clips can be made");
  for (const s of ["clip_preview", "clip_save", "clip_play", "clip_download", "export_evidence"]) assert.ok(adm.includes("<code>" + s + "</code>"), "the see-through legend names " + s);
  // switching evidence off hides the owner's card again once the pad has no clips (and refuses new ones)
  await EV.setOn(false, { userId: U.adm.userId, username: "adm" });
  await runQuery("DELETE FROM evidence_clips WHERE room_id = ?", [ROOM.id]);
  assert.equal(await EV.padCard(ROOM.id, U.own), null, "off + no clips: no card");
  await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
});

test("the shared wire fixture (pinned in both repos): the site's job carries what Pepe reads; Pepe's answer, refusal and upload pass the real routes", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, { userId: U.adm.userId, username: "adm" });
  assert.equal(crypto.createHash("sha256").update(WIRE_RAW).digest("hex"), WIRE_PIN, "regenerate in camfrog-bot (tools/gen_evidence_wire.py) and re-pin BOTH repos");
  assert.ok(!WIRE_RAW.includes(Buffer.from("\r\n")), "LF line ends");
  if (process.env.PEPE_BOT_DIR) {
    const p = path.join(process.env.PEPE_BOT_DIR, "ci", "fixtures", "evidence-wire.json");
    assert.ok(fs.existsSync(p) && fs.readFileSync(p).equals(WIRE_RAW), "the bot's copy is byte-identical");
  }
  const FX = JSON.parse(WIRE_RAW.toString("utf8"));
  // the job as the site offers it carries every key Pepe reads, with the types he checks
  const { hk } = await freshLines();
  resetLimits();
  const r = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: hk.c } });
  assert.equal(r.status, 200, r.text);
  const offered = relay.takeJobs(new Set([ROOM.id])).find((j) => j.id === r.d.id);
  for (const k of FX.job_reads) assert.ok(k in offered, "the offered job has " + k);
  assert.equal(offered.kind, FX.job.kind);
  assert.ok(Number.isInteger(offered.veil_ok) && offered.veil_ok > 0, "veil_ok: a positive int (Pepe refuses anything else)");
  assert.match(offered.id, /^w[a-f0-9]{16}$/);
  // Pepe's answer, as his builders make it, accepted for a matching audited request; his refusal recorded
  const pend = (id, stId) => EV._pending.set(id, { id, roomId: ROOM.id, slug: SLUG, c: 1, tx: FX.job.tx, target: FX.job.target, veil: FX.job.veil, saidAt: Date.now(),
                                                   userId: U.adm.userId, username: "adm", role: "admin", stId, reason: "", state: "pending", status: "", ts: Date.now(), done: 0, secs: 0 });
  pend(FX.answer_ok.id, FX.job.veil_ok);
  const a = await call("POST", FX.paths.answer, { body: Object.assign({ password: "bot" }, FX.answer_ok) });
  assert.equal(a.status, 200, a.text);
  assert.equal(EV._pending.get(FX.answer_ok.id).state, "ready", "Pepe's real answer body is accepted");
  pend(FX.answer_failed.id, FX.job.veil_ok);
  assert.equal((await call("POST", FX.paths.answer, { body: Object.assign({ password: "bot" }, FX.answer_failed) })).status, 200);
  assert.equal(EV._pending.get(FX.answer_failed.id).state, "failed", "his refusal is recorded");
  // his upload, for a requester whose Camfrog login is an admin's
  if (!U.boss) U.boss = await mkUser("boss", "Admin", "boss");
  const u = await call("POST", FX.paths.upload, { body: Object.assign({ password: "bot" }, FX.upload) });
  assert.equal(u.status, 200, u.text);
  const row = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [u.d.id]))[0];
  assert.ok(row && row.subject_login === FX.upload.target && row.veil === FX.upload.veil && row.tx === FX.upload.tx && row.via === "camfrog");
  for (const id of [FX.answer_ok.id, FX.answer_failed.id]) EV._pending.delete(id);
});

// ── wave 2 WP-5 review fixes ──
const ADMIN = () => ({ userId: U.adm.userId, username: "adm" });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
/** A clip row straight into the store (and its file unless file: false). */
async function rawClip({ room = ROOM.id, subject = "hankhidden", veil = "hidden", saidAt = Date.now(), expires = Date.now() + 30 * D, hold = null, gone = null, file = true } = {}) {
  const id = "ev" + crypto.randomBytes(8).toString("hex");
  const name = crypto.randomBytes(16).toString("hex") + ".m4a";
  const f = EV.filePath(name, EVDIR);
  if (file) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, M4A); }
  await runQuery(`INSERT INTO evidence_clips (id, room_id, subject_login, veil, said_at, secs, bytes, file, by_user, role, via, created, expires_at, hold_at, subject_gone_at)
                  VALUES (?, ?, ?, ?, ?, 3, ?, ?, ?, 'admin', 'web', ?, ?, ?, ?)`,
                 [id, room, subject, veil, saidAt, M4A.length, name, U.adm.userId, expires - 30 * D, expires, hold, gone]);
  return { id, file: f };
}

test("review fixes (WP5-ACC-1/2, R3, WP5-T1): the export - dark with either switch off, even for a link minted while on; mentions of people forgotten or hidden since stay \"someone\"; a named line of someone incognito NOW is shown as members see it", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, ADMIN());
  const ask = (u, over = {}) => call("POST", "/api/admin/evidence-export", { user: u, body: Object.assign({ room: SLUG, from: Date.now() - 3600e3, to: Date.now() + 60e3, fmt: "txt", reason: "report #7" }, over) });
  const m = await ask(U.adm);
  assert.equal(m.status, 200, m.text);
  const n0 = (await scopeRows("export_evidence")).length;
  await EV.setOn(false, ADMIN());
  const g = await call("GET", m.d.url, { user: U.adm });
  assert.equal(g.status, 409, "a link minted while on sends nothing after the switch-off");
  assert.ok(!g.text.includes("Evidence export by"), "no file");
  assert.equal((await scopeRows("export_evidence")).length, n0, "nothing logged");
  assert.equal((await call("GET", m.d.url, { user: U.adm })).status, 404, "and the link is spent");
  assert.equal((await ask(U.adm)).status, 409, "evidence clips off: refused");
  await EV.setOn(true, ADMIN());
  await PW.setOn(false, ADMIN());
  assert.equal(EV.effective(), false);
  const pw = await ask(U.adm);
  assert.equal(pw.status, 409, "privacy wire v2 off (evidence clips still on): refused too");
  assert.equal(pw.d.code, "evidence_off");
  await PW.setOn(true, ADMIN());
  // mentions + the decision-9 rule
  await sync([
    ev("message", { user: real("davecf", "Dave"), text: "dave was here" }),
    ev("message", { user: real("carolcf", "Carol"), text: "davecf keeps spamming the room" }),
    ev("message", { user: real("erincf", "Erin"), text: "a named line before going incognito" }),
  ]);
  await settle();
  await CL.hideNow(["davecf"], "forget");
  await CL.hideNow(["erincf"], "pepe", "incognito");
  for (const fmt of ["txt", "jsonl"]) {
    const r = await ask(U.adm, { fmt });
    assert.equal(r.status, 200, r.text);
    const f = await call("GET", r.d.url, { user: U.adm });
    assert.equal(f.status, 200, f.text.slice(0, 200));
    assert.ok(f.text.includes("someone keeps spamming the room"), fmt + ": the forgotten login inside another line is \"someone\"");
    assert.ok(!f.text.includes("davecf keeps"), fmt + ": never named there");
    assert.ok(!f.text.includes("dave was here"), fmt + ": their own line stays out");
    assert.ok(!f.text.includes("erincf") && !f.text.includes("Erin"), fmt + ": a speaker incognito NOW (no identity row) isn't named");
    if (fmt === "txt") {
      assert.ok(f.text.includes("carolcf (Carol): someone keeps spamming the room"), "the named speaker keeps their name");
      assert.match(f.text, /\] someone \[incognito, can't be revealed\]: a named line before going incognito/, "shown as members see it, counted");
    } else {
      const rows = f.text.trim().split("\n").map((x) => JSON.parse(x));
      assert.ok(rows.some((o) => o.text === "a named line before going incognito" && o.login === null && o.display === "someone" && o.unrevealable === true));
    }
  }
});

test("review fix WP5-T7: the daily export limit counts the links an admin holds - minting first can't get past it", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, ADMIN());
  if (!U.adm3) U.adm3 = await mkUser("adm3", "Admin", "adm3cf");
  const keep = EX._limits.perDay;
  EX._limits.perDay = 2;
  try {
    const ask = () => call("POST", "/api/admin/evidence-export", { user: U.adm3, body: { room: SLUG, from: Date.now() - 3600e3, to: Date.now(), fmt: "txt", reason: "limit test" } });
    const a = await ask(), b = await ask();
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    const c = await ask();
    assert.equal(c.status, 429, "two links held: the third is refused before any download");
    assert.equal(c.d.code, "limit_day");
    assert.equal((await call("GET", a.d.url, { user: U.adm3 })).status, 200);
    assert.equal((await ask()).status, 429, "one download + one link held");
    assert.equal((await call("GET", b.d.url, { user: U.adm3 })).status, 200);
    assert.equal((await ask()).status, 429, "two downloads");
    assert.equal((await auditRows("evidence.export")).filter((x) => x.admin_id === U.adm3.userId).length, 2, "never more than the limit");
  } finally { EX._limits.perDay = keep; }
});

test("review fix WP5-T8: an export naming more than 200 logins logs every one of them (the row is split, same ref)", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, ADMIN());
  const t = Date.now();
  await sync(Array.from({ length: 230 }, (_, i) => ev("message", { user: real("crowd" + i, "Crowd " + i), text: "line " + i }, t - 1000 + i)));
  await settle(80);
  const r = await call("POST", "/api/admin/evidence-export", { user: U.adm2, body: { room: SLUG, from: t - 5000, to: t + 5000, fmt: "txt", reason: "crowd case" } });
  assert.equal(r.status, 200, r.text);
  const maxId = Number(((await getQuery("SELECT MAX(id) AS m FROM seethrough_log"))[0] || {}).m) || 0;
  const f = await call("GET", r.d.url, { user: U.adm2 });
  assert.equal(f.status, 200);
  const got = await getQuery("SELECT * FROM seethrough_log WHERE scope = 'export_evidence' AND id > ?", [maxId]);
  assert.ok(got.length >= 2 && new Set(got.map((x) => x.ref)).size === 1, "split over rows with one ref");
  const all = new Set(got.flatMap((x) => JSON.parse(x.logins)));
  for (let i = 0; i < 230; i++) assert.ok(all.has("crowd" + i), "crowd" + i + " logged");
  const a = (await auditRows("evidence.export")).slice(-1)[0];
  assert.equal(JSON.parse(a.detail).st_rows, got.length, "the audit row says how many");
});

test("review fixes (WP5-ACC-3, R1, R7, WP5-T3): 200+ clips under a chat legal hold never stall the sweep; a hold placed mid-sweep keeps row AND file; the count is what really went", async () => {
  await setup;
  await runQuery("DELETE FROM evidence_clips");
  const rk = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [ROOM.id]))[0].rk;
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, ?, ?, ?)", ["room:" + rk, U.adm.userId, "a long case", Date.now()]);
  const t0 = Date.now() - 40 * D;
  for (let i = 0; i < EV.SWEEP_PAGE + 5; i++) await rawClip({ expires: t0 + i, file: false });
  const loose = await rawClip({ room: OTHER.id, subject: "bobcf", veil: "incognito", expires: t0 + 1000 });
  for (const pass of [1, 2]) {
    const s = await EV.sweep();
    assert.equal(s.held, EV.SWEEP_PAGE + 5, `pass ${pass}: every held row looked at once`);
    assert.equal(s.deleted, pass === 1 ? 1 : 0, `pass ${pass}`);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips WHERE id = ?", [loose.id]))[0].n, 0, "the unheld clip behind them went");
  assert.ok(!fs.existsSync(loose.file), "with its file");
  await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["room:" + rk]);
  await runQuery("DELETE FROM evidence_clips");
  // a clip hold placed while the sweep runs (after its page was read, before it reaches the row)
  const N = 150, made = [];
  for (let i = 0; i < N; i++) made.push(await rawClip({ room: OTHER.id, subject: "bobcf", veil: "incognito", expires: t0 + i }));
  const last = made[N - 1];
  const count = async () => Number((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n);
  const run = EV.sweep();
  while ((await count()) === N) await new Promise((r) => setImmediate(r));
  await runQuery("UPDATE evidence_clips SET hold_at = ?, hold_by = ?, hold_why = 'court order 9' WHERE id = ?", [Date.now(), U.adm.userId, last.id]);
  const s = await run;
  const row = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [last.id]))[0];
  assert.ok(row && row.hold_at, "the late hold kept the row");
  assert.ok(fs.existsSync(last.file), "...and its audio (the row goes first, the file only after)");
  assert.equal(s.deleted, N - 1, "deleted = the rows that really went");
  assert.equal(await count(), 1);
  assert.equal(s.failed, 0, "(a file that won't go would be counted, and retried by the orphan pass)");
  await runQuery("DELETE FROM evidence_clips");
});

test("review fixes (WP5-ACC-4/6/8, R6, WP5-T5, WP5-T8): listing logs every subject newly shown (split past 200); owners never see subject_gone; a lapsed clip is neither listed nor served; the owner era bounds the list, the audio and the pad card", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, ADMIN());
  await runQuery("DELETE FROM evidence_clips");
  EV._seen.clear();
  const list = (u, q) => call("GET", "/api/evidence" + q, { user: u });
  const since = await ST.ownerEra(ROOM.id, U.own.userId);
  assert.ok(since > 0, "the owner has an era");
  // a subject shown later within the hour is logged too - only the new one
  const base0 = (await scopeRows("clip_list")).length;
  await rawClip({ subject: "subja" });
  assert.equal((await list(U.own, "?room=" + SLUG)).status, 200);
  let rows = await scopeRows("clip_list");
  assert.equal(rows.length, base0 + 1);
  assert.deepEqual(JSON.parse(rows[rows.length - 1].logins), ["subja"]);
  const c = await rawClip({ subject: "subjc" });
  const l2 = await list(U.own, "?room=" + SLUG);
  assert.ok(l2.d.rows.some((r) => r.subject === "subjc"));
  rows = await scopeRows("clip_list");
  assert.equal(rows.length, base0 + 2, "the newly shown subject gets its row");
  assert.deepEqual(JSON.parse(rows[rows.length - 1].logins), ["subjc"]);
  await list(U.own, "?room=" + SLUG);
  assert.equal((await scopeRows("clip_list")).length, base0 + 2, "nothing new shown: no new row within the hour");
  // subject_gone: admins only
  await runQuery("UPDATE evidence_clips SET subject_gone_at = ? WHERE id = ?", [Date.now(), c.id]);
  const ow = (await list(U.own, "?room=" + SLUG)).d.rows.find((r) => r.id === c.id);
  assert.ok(ow && !("subject_gone" in ow), "a pad's owner never learns the subject used forget-me / deleted their account");
  const ad = (await list(U.adm, "?room=" + SLUG)).d.rows.find((r) => r.id === c.id);
  assert.equal(ad.subject_gone, true, "admins do");
  assert.ok(!fs.readFileSync(path.join(repo, "public", "js", "pad-evidence.js"), "utf8").includes("r.subject_gone"), "the owner's list never renders it");
  // lapsed (past expires_at, no hold): gone for everyone whenever the sweep runs; a hold keeps it
  const lap = await rawClip({ subject: "subjold", expires: Date.now() - 1000 });
  assert.ok(!(await list(U.adm, "?room=" + SLUG)).d.rows.some((r) => r.id === lap.id), "not listed");
  assert.equal((await call("GET", `/api/evidence/${lap.id}/audio`, { user: U.adm })).status, 410, "not served");
  await runQuery("UPDATE evidence_clips SET hold_at = ?, hold_by = ?, hold_why = 'case' WHERE id = ?", [Date.now(), U.adm.userId, lap.id]);
  assert.ok((await list(U.adm, "?room=" + SLUG)).d.rows.some((r) => r.id === lap.id), "under a hold: listed");
  assert.equal((await call("GET", `/api/evidence/${lap.id}/audio`, { user: U.adm })).status, 200, "and served");
  assert.ok(EV.BOOT_SWEEP_MS > 0 && EV.BOOT_SWEEP_MS <= 120e3, "a sweep shortly after every start");
  assert.match(fs.readFileSync(path.join(repo, "evidence.js"), "utf8"), /setTimeout\(\(\) => sweep\(\)[^\n]*BOOT_SWEEP_MS\)/);
  // the owner era: a clip said before it is not theirs - not listed, not played, no card
  const pre = await rawClip({ subject: "subjpre", saidAt: since - 3600e3 });
  assert.ok(!(await list(U.own, "?room=" + SLUG)).d.rows.some((r) => r.id === pre.id), "owner: not listed");
  assert.ok((await list(U.adm, "?room=" + SLUG)).d.rows.some((r) => r.id === pre.id), "admins: listed");
  assert.equal((await call("GET", `/api/evidence/${pre.id}/audio`, { user: U.own })).status, 404, "owner: not played");
  assert.equal((await call("GET", `/api/evidence/${pre.id}/audio`, { user: U.adm })).status, 200, "admins: played");
  await runQuery("DELETE FROM evidence_clips WHERE id != ?", [pre.id]);
  await EV.setOn(false, ADMIN());
  try {
    assert.equal(await EV.padCard(ROOM.id, U.own), null, "switch off + only an earlier era's clip: no card (nothing says evidence exists)");
    await rawClip({ subject: "subjnow" });
    assert.deepEqual(await EV.padCard(ROOM.id, U.own), { on: false, n: 1 }, "a clip of their era: the card");
  } finally { await EV.setOn(true, ADMIN()); }
  // more than 200 subjects in one list: split over rows, none dropped
  await runQuery("DELETE FROM evidence_clips");
  EV._seen.clear();
  for (let i = 0; i < 230; i++) await rawClip({ room: OTHER.id, subject: "many" + i, veil: "incognito", file: false });
  const maxId = Number(((await getQuery("SELECT MAX(id) AS m FROM seethrough_log"))[0] || {}).m) || 0;
  const big = await list(U.adm, "?room=" + encodeURIComponent(OTHER.id) + "&limit=500");
  assert.equal(big.d.rows.length, 230);
  const got = await getQuery("SELECT * FROM seethrough_log WHERE scope = 'clip_list' AND id > ?", [maxId]);
  assert.equal(got.length, 2, "two rows (200 + 30)");
  assert.equal(new Set(got.flatMap((r) => JSON.parse(r.logins))).size, 230, "every subject logged");
  await runQuery("DELETE FROM evidence_clips");
});

test("review fixes (R2, WP5-T2): Pepe's long evidence turns arrive in chunks on both routes, staged in the store's pending/ (never uploads/.botupload); the shared fixture names the chunked paths", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, ADMIN());
  const FX = JSON.parse(WIRE_RAW.toString("utf8"));
  assert.ok(FX.chunked && Array.isArray(FX.chunked.paths), "the fixture's chunked block (from Pepe's real constants)");
  assert.deepEqual([...FX.chunked.paths].sort(), Object.values(FX.paths).sort(), "both evidence bodies go through _backend_post (chunked over its limit)");
  const kbps = parseInt(String(FX.chunked.bitrate), 10);
  const maxBody = Math.ceil(FX.chunked.max_turn_secs * kbps * 1000 / 8 * 1.25 * 4 / 3) + 4096;     // the longest turn, container slack, base64
  assert.ok(maxBody > 1024 * 1024 && FX.chunked.over < 1024 * 1024, "a long turn can't pass nginx's 1m in one piece - it must be chunked");
  for (const p of FX.chunked.paths) {
    assert.ok(BU.TARGETS[p] >= maxBody, p + " takes chunks, capped above the longest turn");
    assert.ok(BU.PRIVATE.includes(p), p + " is staged privately");
    assert.ok(String(BU.rootFor(p, false)).startsWith(EVDIR), p + ": in the store's own directory");
  }
  const BIG = Buffer.concat([M4A.subarray(0, 12), crypto.randomBytes(1200000)]);        // ~200 s of 48k AAC: ~1.6 MB of base64 JSON
  async function viaChunks(target, payload) {
    const raw = Buffer.from(JSON.stringify(Object.assign({ password: "bot" }, payload)));
    const slice = 384 * 1024, total = Math.ceil(raw.length / slice), id = crypto.randomBytes(8).toString("hex");
    assert.ok(raw.length > 1024 * 1024, "the body is over nginx's limit");
    for (let i = 0; i < total; i++) {
      const body = { password: "bot", id, target, seq: i, total, size: raw.length, data: raw.subarray(i * slice, (i + 1) * slice).toString("base64") };
      assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024 * 1024, "each chunk fits under nginx's 1m");
      const r = await call("POST", "/api/bot/upload/chunk", { body });
      assert.equal(r.status, 200, target + ": " + r.text);
      assert.ok(fs.existsSync(path.join(EVDIR, "pending", "chunks", id, "p" + i)), "staged in the store's pending/");
      assert.ok(!fs.existsSync(path.join(BUDIR, id)), "never under uploads/.botupload");
    }
    const fin = await call("POST", "/api/bot/upload/finish", { body: { password: "bot", id, target, sha256: sha(raw) } });
    assert.ok(!fs.existsSync(path.join(EVDIR, "pending", "chunks", id, "p0")), "the slices go once delivered");
    return fin;
  }
  // the website path: Pepe's answer to a preview job
  const { hk } = await freshLines();
  resetLimits();
  const r = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: hk.c } });
  assert.equal(r.status, 200, r.text);
  const job = relay._jobs.get(r.d.id);
  const fin = await viaChunks("/api/bridge/evidence", { id: job.id, state: "ok", status: "ok", data: BIG.toString("base64"), secs: 200, target: job.target, veil: job.veil, veil_ok: job.veil_ok });
  assert.equal(fin.status, 200, fin.text);
  assert.equal(EV._pending.get(r.d.id).state, "ready", "the long preview arrived");
  const au = await call("GET", `/api/rooms/${SLUG}/evidence/${r.d.id}/audio`, { user: U.adm });
  assert.ok(au.status === 200 && au.buf.equals(BIG), "byte for byte");
  await call("POST", `/api/rooms/${SLUG}/evidence/${r.d.id}/discard`, { user: U.adm, body: {} });
  // the Camfrog path: the upload
  const up = await viaChunks("/api/bridge/evidence/upload", { room: ROOM.id, target: "hankhidden", veil: "hidden", requester: "admcf", said_at: Date.now() / 1000 - 5, secs: 200,
                                                              tx: "tx-00000000000000aa", data: BIG.toString("base64") });
  assert.equal(up.status, 200, up.text);
  const row = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [up.d.id]))[0];
  assert.ok(row && row.bytes === BIG.length && row.sha256 === sha(BIG), "the long clip is stored whole");
  await runQuery("DELETE FROM evidence_clips WHERE id = ?", [up.d.id]);
});

test("review fixes (WP5-T5, WP5-ACC-7): every guard on the website path has a test - no identity row, past 15 minutes, switched off before Save, the right lost before Save; a preview stops playing once the right is gone", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, ADMIN());
  // the request: revealLookup's refusal (the line's identity row is gone)
  let L = await freshLines();
  await runQuery("DELETE FROM bridge_veil WHERE c = ?", [L.hk.c]);
  resetLimits();
  const r3 = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: L.hk.c } });
  assert.equal(r3.status, 404, "no identity row: not evidence");
  assert.equal(r3.d.code, "not_evidence");
  // the request: Pepe's 15 minutes
  L = await freshLines();
  L.fr.ts = Date.now() - 16 * 60e3;
  resetLimits();
  const r4 = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: L.fr.c } });
  assert.equal(r4.status, 410, r4.text);
  assert.equal(r4.d.code, "too_old");
  // save: evidence clips switched off after the preview
  L = await freshLines();
  resetLimits();
  const p2 = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: L.hk.c } });
  assert.equal(p2.status, 200, p2.text);
  assert.equal((await answer(relay._jobs.get(p2.d.id))).status, 200);
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n;
  await EV.setOn(false, ADMIN());
  const s2 = await call("POST", `/api/rooms/${SLUG}/evidence/${p2.d.id}/save`, { user: U.adm, body: {} });
  await EV.setOn(true, ADMIN());
  assert.equal(s2.status, 409, "switched off: no save");
  assert.equal(s2.d.code, "evidence_off");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n, n0);
  await call("POST", `/api/rooms/${SLUG}/evidence/${p2.d.id}/discard`, { user: U.adm, body: {} });
  // the owner loses the pad between the preview and Save
  L = await freshLines();
  resetLimits();
  const pa = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.own, body: { c: L.fr.c } });
  assert.equal(pa.status, 200, pa.text);
  assert.equal((await answer(relay._jobs.get(pa.d.id))).status, 200);
  resetLimits();
  const pb = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.own, body: { c: L.hk.c } });
  assert.equal(pb.status, 200, pb.text);
  assert.equal((await answer(relay._jobs.get(pb.d.id))).status, 200);
  assert.equal((await call("GET", `/api/rooms/${SLUG}/evidence/${pb.d.id}`, { user: U.own })).d.state, "ready", "still theirs");
  assert.equal((await call("GET", `/api/rooms/${SLUG}/evidence/${pb.d.id}/audio`, { user: U.own })).status, 200);
  await rooms.setOwner(ROOM.id, "own2", "test");
  try {
    assert.equal(await ST.chatRole(U.own, ROOM.id), null, "no longer the owner");
    const sa = await call("POST", `/api/rooms/${SLUG}/evidence/${pa.d.id}/save`, { user: U.own, body: {} });
    assert.equal(sa.status, 403, "save re-checks the right");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n, n0);
    assert.equal((await call("GET", `/api/rooms/${SLUG}/evidence/${pb.d.id}/audio`, { user: U.own })).status, 404, "the preview stops playing");
    assert.equal((await call("GET", `/api/rooms/${SLUG}/evidence/${pb.d.id}`, { user: U.own })).status, 404, "its status too");
    assert.ok(!EV._pending.has(pb.d.id), "and it goes at once");
  } finally {
    await rooms.setOwner(ROOM.id, "own", "test");
    EV._pending.delete(pa.d.id);
  }
});

test("review fix XT-3: the role comes FIRST - a member gets the same 403 for every cursor (a veiled 🎙 turn, a named turn, a chat line, one that doesn't exist, one whose identity row is gone) and nothing is written", async () => {
  await setup;
  if (!EV.isOn()) await EV.setOn(true, ADMIN());
  const L = await freshLines();
  const msg = R0().feed.find((x) => x.k === "msg");
  // what an account deletion without "also hide my past lines" does to the side table (accountdelete -> veil.forgetLogins): the line
  // stays on the page under its frog name, its identity row is gone
  await require(path.join(repo, "veil")).forgetLogins(["u:id-frankie", "frankiefettuccine"]);
  assert.ok(R0().feed.some((x) => x.c === L.fr.c), "(the line is still in the live feed)");
  assert.equal(await bridge.revealLookup(ROOM.id, L.fr.c), null, "(no identity row behind it now)");
  const n0 = { st: (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, aa: (await getQuery("SELECT COUNT(*) AS n FROM admin_audit"))[0].n };
  const probes = [["a hidden 🎙 turn", L.hk.c], ["a forgotten 🎙 turn", L.fr.c], ["a named turn", L.al.c], ["a chat line", msg && msg.c], ["no such line", 987654321]];
  for (const u of [U.mem, U.staff, U.own2]) {
    for (const [what, c] of probes) {
      resetLimits();
      const r = await call("POST", `/api/rooms/${SLUG}/evidence`, { user: u, body: { c } });
      assert.deepEqual([r.status, r.d && r.d.code], [403, "not_entitled"], u.username + ", " + what + ": " + r.text);
    }
  }
  // an entitled admin still gets the line's own answer
  resetLimits();
  assert.equal((await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: L.fr.c } })).status, 404, "admin: the forgotten turn is no evidence clip");
  resetLimits();
  assert.equal((await call("POST", `/api/rooms/${SLUG}/evidence`, { user: U.adm, body: { c: 987654321 } })).status, 404, "admin: no such line");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, n0.st, "no see-through row");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit"))[0].n, n0.aa, "no audit row");
});
