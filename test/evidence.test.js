// wave 2 WP-5 (incognito / mic-stage spec E.3, E.4, E.5, H, I.3 WP-5, I.4; owner J-7 + the M addenda): moderation evidence clips
// (evidence.js) and the admin evidence export (evidenceexport.js).
//   * dark: with the evidence switch off (or privacy wire v2 off) no route makes a clip (409), the sync answer never says
//     `evidence`, reveal answers carry no offer, the privacy copy is null and the sweep is a no-op on an empty table
//   * an evidence clip only with see-through: an admin anywhere, the pad's owner in their era; a member, staff, another pad's owner and
//     a signed-out visitor are refused - on the website path and the Camfrog upload alike
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

const D = 864e5;
const EVDIR = path.join(tmp, "evidence-store");
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
const WIRE_PIN = "dd2c95438a0ef3805d388ffde0aec353510616d1a0b6b39b1008955c27dd4ca4";
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
  app.use((req, res, next) => (["/api/bridge/sync", "/api/bridge/sync/v2", "/api/bridge/evidence", "/api/bridge/evidence/upload", "/api/bridge/micclip"].includes(req.path)
    ? next() : express.json()(req, res, next)));
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
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n, 0);
  assert.deepEqual(await EV.sweep(), { deleted: 0, held: 0, pending: 0, orphans: 0 }, "the sweep: a no-op on an empty table");
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
  assert.deepEqual(req, ["accountdelete.js", "bridge.js", "padsettings.js", "pepeforget.js", "seethrough.js", "terms.js"].sort(),
                   "require('./evidence'): the advert, the reveal offer, the policy copy, the owner card and the lifecycle hooks only");
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
