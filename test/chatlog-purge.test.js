// CL7 chatlogpurge.js: the pad chat archive's retention purge (the chat-history spec §3.12 "Purge", §3.15, §4 CL7).
//   * the cutoffs per tier and class: a free pad's lines past 30 days go - with their FTS entries, their bridge_feed rows and
//     live-feed items, the room's counters - 🎙 lines by the recording window (Prime Time: chat for good, 🎙 365 days; Plus:
//     everything for good); nothing is due before the archive is 30 days old; exp_* is raised to the cutoff;
//   * the fail-safes: no retention report from Pepe in the last hour (or none since the start), an unknown tier, premium.js not
//     loaded -> nothing deleted and no exp_* moved; the purge switch off = report-only (exp_* still follows the cutoff) - and
//     CL6's 30-day text removal runs whatever the mode; a recount deletes and moves nothing;
//   * legal holds (a room, a speaker - their already-purged lines too) and open reports keep their lines; released, the next
//     pass deletes them;
//   * batches: keyset in (ts, c) over equal times and kept rows, 1,000 a transaction by default, a slow batch halves the next;
//   * the downgrade grace: nothing past the lower tier is deleted for 30 days, an upgrade inside it keeps everything, after it
//     the lines go; exp_* only moves forward;
//   * the report: what the next 7 days would delete, day by day (the grace's end included), on the admin card's API (site
//     admins only, a same-origin fetch to start a pass);
//   * the schedule (once a night, any hour when late, again after a pass cut short), a refresh of a hidden person's names never
//     loses one the purge took away, Pepe's report time.
//   CL7 fix-up: a second downgrade inside a grace keeps its own 30 days; a hold / an open report that comes in mid-pass is
//   honoured; a stale report (or a recount, or a view meanwhile) writes no exp_* - the columns are checked; a report with a bad
//   or missing window is stale; a pass that couldn't delete is retried at the next hourly check; the clock check (behind the
//   last pass, a step against the monotonic clock); a rows counter at 0 skips nothing; never-archived live lines leave
//   bridge_feed and the live feed by age; the takedown ring isn't flooded; first_c / first_ts follow; the FTS merge.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-purge.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-purge-test-"));
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
const CLM = require(path.join(repo, "chatlogmod"));
const CP = require(path.join(repo, "chatlogpurge"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const P = require(path.join(repo, "premium"));

const H = 3600e3, D = 864e5;
let offset = 0;
CL._setClock(() => Date.now() + offset);
const T = () => CL.now();

// tiers per room (premium.padPerks is the source; stubbed per room), the 💎 gate open, Pepe's retention report fresh unless a
// test says otherwise (premium.retentionAt)
const TIER = new Map();
const realPerks = P.padPerks, realAt = P.retentionAt;
P.padPerks = (id) => Object.assign({}, realPerks(id), { retention: TIER.has(id) ? TIER.get(id) : "standard" });
P.bridgeAllowed = () => true;
let reportAt = () => T() - 60e3;
P.retentionAt = () => reportAt();

const ALICE = { id: "alicecf", login: "alicecf", display: "Alice" };
const BOB = { id: "bobcf", login: "bobcf", display: "Bob" };
const CAROL = { id: "carolcf", login: "carolcf", display: "Carol" };
const DAVE = { id: "davecf", login: "davecf", display: "Dave" };
let seq = 0, txSeq = 0;
const ev = (room, type, data, ts) => ({ op: "event", id: "pg-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const snap = (room) => ({ room, members: [ALICE, BOB, CAROL, DAVE], mic: [], count: 4, transcripts: true });
const txId = () => "tx-" + (++txSeq).toString(16).padStart(12, "0");
/** Lines into a room through the real ingest (archived: the archive is on). spec: [kind, text|null, age ms, user?]. -> text -> c */
async function seed(room, tier, spec) {
  if (tier) TIER.set(room.id, tier);
  const now = Date.now() + offset;
  const events = spec.map(([k, text, age, user = ALICE]) => {
    const ts = now - age;
    if (k === "msg") return ev(room, "message", { user, text }, ts);
    if (k === "tx") return ev(room, "x.pepe.transcript", { id: txId(), user, text }, ts);
    if (k === "join") return ev(room, "member.join", { user }, ts);
    if (k === "topic") return ev(room, "room.update", { changes: { topic: text } }, ts);
    throw new Error(k);
  });
  await bridge.ingest({ rooms: [snap(room)], events });
  const out = {};
  for (const r of await getQuery("SELECT c, text FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE r.room_id = ? AND text IS NOT NULL", [room.id])) out[r.text] = Number(r.c);
  return out;
}
const rkOf = async (room) => Number((await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [room.id]))[0].rk);
const texts = async (room) => (await getQuery(`SELECT l.text, l.k FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE r.room_id = ? ORDER BY l.c`, [room.id]))
  .map((x) => x.text || x.k);
const ftsHas = async (word) => (await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ?", ['"' + word + '"'])).length > 0;
const roomRow = async (room) => (await getQuery("SELECT * FROM chatlog_rooms WHERE room_id = ?", [room.id]))[0];
async function countersOk(room) {
  const rk = await rkOf(room);
  const r = (await getQuery(`SELECT "rows" AS n, idx_rows FROM chatlog_rooms WHERE rk = ?`, [rk]))[0];
  const n = Number((await getQuery("SELECT COUNT(*) AS n FROM chat_log WHERE rk = ?", [rk]))[0].n);
  const idx = Number((await getQuery(`SELECT COUNT(*) AS n FROM chat_log WHERE rk = ? AND ${CL.INDEXABLE}`, [rk]))[0].n);
  assert.equal(Number(r.n), n, room.id + ": the rows counter follows the deletes");
  assert.equal(Number(r.idx_rows), idx, room.id + ": the indexed-rows counter too");
}
async function indexOk() {
  const a = Number((await getQuery(`SELECT COUNT(*) AS n FROM chat_log WHERE ${CL.INDEXABLE}`))[0].n);
  const b = Number((await getQuery("SELECT COUNT(*) AS n FROM chat_log_fts_docsize"))[0].n);
  assert.equal(b, a, "the FTS index holds exactly the indexable rows");
  assert.equal((await CL.driftCheck({ full: true })).ok, true, "a full drift check agrees");
}
const roomOf = (rep, room) => (rep.rooms || []).find((x) => x.room_id === room.id);
// (the bridge keeps at most 20 rooms: the later tests let theirs go when they end - their archive rows stay)
const freeRooms = (...rs) => { for (const r of rs) bridge._rooms.delete(r.id); };
const near = (a, b, ms = 5000) => Math.abs(Number(a) - Number(b)) <= ms;

let base = null;
const ADMIN = { userId: "u_boss", username: "boss", class: "Admin" }, STAFF = { userId: "u_helper", username: "helper", class: "Staff" };
function call(method, url, who, body, { csrf = true } = {}) {
  const headers = { "content-type": "application/json", ...(who ? { "x-test-user": who.userId } : {}), ...(csrf ? { "x-requested-with": "fetch", origin: base } : {}) };
  const data = body === undefined ? null : JSON.stringify(body);
  if (data) headers["content-length"] = Buffer.byteLength(data);
  return new Promise((resolve, reject) => {
    const req = http.request(base + url, { method, headers }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (x) => { s += x; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// (a promise every test awaits - Node 16's runner has no test.before / after)
const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  for (const u of [ADMIN, STAFF]) await runQuery("INSERT INTO users (userId, username, password, class) VALUES (?, ?, 'x', ?)", [u.userId, u.username, u.class]);
  await bridge.load();
  await CL.init();
  await rooms.init();
  await PA.init();
  await P.init();
  await CV.init();
  await CLM.init();
  // the archive on (the notice 8 days ago)
  offset = -8 * D;
  await CL.setSwitch("notice", true, "test");
  offset = 0;
  await CL.setSwitch("archive", true, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = [ADMIN, STAFF].find((u) => u.userId === id) || null; next(); };
  CP.register(app, { addUser });
  const server = app.listen(0);
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
})();
// (CL7 fix-up: each test starts with no last pass - a test that moved the clock ahead and ran one would otherwise read as the clock
// going back, which deletes nothing; and with the real clocks for the clock check)
const ready = async () => {
  await setup; offset = 0; reportAt = () => T() - 60e3; CP._setBatch(0); CP._onBatch(null); CP._setClockSource(); CV._clearCaches();
  await runQuery("DELETE FROM chatlog_meta WHERE key = 'purge_pass'");
};

test("the owner decisions as constants, and the purge switch is on by default (decision 15)", async () => {
  await ready();
  assert.equal(CL.SWITCHES.purge, true);
  assert.equal(CP.PURGE_BATCH, 1000);
  assert.equal(CP.REPORT_FRESH_MS, 3600e3, "Pepe's report: an hour");
  assert.equal(CP.LOOKAHEAD_DAYS, 7);
  assert.equal(CP.SKIP_OPEN_REPORTS, true);
  assert.equal(CV.DOWNGRADE_GRACE_MS, 30 * D, "a lapsed tier keeps its lines 30 days");
});

test("Pepe's report time: only a report naming every tier's windows counts (the purge's fail-safe)", async () => {
  await ready();
  const before = realAt();
  await P.noteRetention({ chat_days: 30 });
  assert.equal(realAt(), before, "a partial report isn't a fresh one");
  const t0 = Date.now();
  const good = { chat_days: 30, chat_prime: null, rec_days: 30, rec_prime: 365, pm_days: 30, pm_pass: null, chat_plus: null, rec_plus: null };
  await P.noteRetention(good);
  assert.ok(realAt() >= t0, "a full report is");
  assert.deepEqual([P.retention().chat_days, P.retention().rec_prime, P.retention().chat_prime], [30, 365, null]);
  // CL7 fix-up: every tier's window must be there AND valid - a value cleanRetention would swap for the default (out of range, not a
  // whole number, a string) or a missing Plus window makes the report stale at once (an earlier fresh one no longer counts)
  for (const bad of [{ rec_prime: 50000 }, { chat_days: 30.5 }, { rec_days: "30" }, { chat_prime: 0 }, { chat_plus: undefined }, { rec_plus: -1 }]) {
    await P.noteRetention(good);
    assert.ok(realAt() > 0);
    const raw = Object.assign({}, good, bad);
    for (const k of Object.keys(bad)) if (bad[k] === undefined) delete raw[k];
    await P.noteRetention(raw);
    assert.equal(realAt(), null, "stale: " + JSON.stringify(bad));
  }
  // ...and the purge then reads Pepe's report as stale (premium.retentionAt itself, not the test's stub)
  P.retentionAt = realAt;
  try {
    assert.deepEqual([(await CP.modeNow()).mode, (await CP.modeNow()).why], ["report", "stale_report"]);
    await P.noteRetention(good);
    assert.equal((await CP.modeNow()).mode, "delete", "a whole, valid report: fresh again");
  } finally { P.retentionAt = () => reportAt(); }
  assert.deepEqual(P.RETENTION_TIER_KEYS, ["chat_days", "chat_prime", "chat_plus", "rec_days", "rec_prime", "rec_plus"]);
});

test("the cutoffs per tier and class: a free pad's lines past 30 days go with their FTS entries, bridge_feed rows, live items and counters; Prime keeps chat for good and 🎙 365 days; Plus keeps all; exp_* follows the cutoff", async () => {
  await ready();
  const STD = { id: "Pg.Std", name: "Pg Std" }, PRIME = { id: "Pg.Prime", name: "Pg Prime" }, PLUS = { id: "Pg.Plus", name: "Pg Plus" };
  const lines = (tag) => [["msg", tag + "chat400", 400 * D], ["msg", tag + "chat40", 40 * D], ["join", null, 40 * D, BOB], ["topic", tag + "topic40", 40 * D],
                          ["tx", tag + "mic400", 400 * D], ["tx", tag + "mic40", 40 * D], ["msg", tag + "chat29", 29 * D], ["tx", tag + "mic29", 29 * D],
                          ["msg", tag + "chatnow", H]];
  const cs = await seed(STD, "standard", lines("std"));
  await seed(PRIME, "prime", lines("pri"));
  await seed(PLUS, "unlimited", lines("plu"));
  assert.ok(await ftsHas("stdchat40"));
  const t = T();
  const rep = await CP.run();
  assert.equal(rep.mode, "delete", JSON.stringify(rep));
  assert.equal(rep.error, null);
  // standard: chat 30 days, 🎙 30 days - the joins / topic with them; nothing under 30 days (nothing is due before day 30)
  assert.deepEqual(await texts(STD), ["stdchat29", "stdmic29", "stdchatnow"]);
  for (const w of ["stdchat400", "stdchat40", "stdtopic40", "stdmic400", "stdmic40"]) assert.equal(await ftsHas(w), false, w + " left the index");
  for (const w of ["stdchat29", "stdmic29", "stdchatnow"]) assert.equal(await ftsHas(w), true, w);
  const gone = [cs.stdchat400, cs.stdchat40, cs.stdmic40, cs.stdmic400];
  for (const c of gone) {
    assert.equal((await getQuery("SELECT 1 FROM bridge_feed WHERE c = ?", [c])).length, 0, "bridge_feed row " + c);
    assert.ok(!bridge._rooms.get(STD.id).feed.some((it) => Number(it.c) === c), "the live feed item " + c);
  }
  assert.ok(bridge._rooms.get(STD.id).feed.some((it) => Number(it.c) === cs.stdchat29), "a line inside retention stays live");
  // Prime Time: chat for good, 🎙 365 days
  assert.deepEqual(await texts(PRIME), ["prichat400", "prichat40", "join", "pritopic40", "primic40", "prichat29", "primic29", "prichatnow"]);
  // 💎 Plus: everything for good
  assert.equal((await texts(PLUS)).length, 9);
  for (const r of [STD, PRIME, PLUS]) await countersOk(r);
  await indexOk();
  // exp_* = the deletion cutoff (the read paths' floors), per class; for good = 0
  const s = await roomRow(STD), p = await roomRow(PRIME), u = await roomRow(PLUS);
  assert.ok(near(s.exp_chat, t - 30 * D) && near(s.exp_tx, t - 30 * D), JSON.stringify(s));
  assert.ok(Number(p.exp_chat) === 0 && near(p.exp_tx, t - 365 * D), JSON.stringify(p));
  assert.ok(Number(u.exp_chat) === 0 && Number(u.exp_tx) === 0);
  assert.ok(near(CV._rows.get(STD.id).exp_chat, s.exp_chat, 0), "the read side's cached row follows");
  // CL7 fix-up: the archive's first line (the admin card's "Since", view().start_ts) moves up to the oldest line left; the pass
  // ends with an FTS merge step (the deleted words leave the index's segments)
  const firstLeft = (await getQuery("SELECT c, ts FROM chat_log WHERE rk = ? ORDER BY c LIMIT 1", [await rkOf(STD)]))[0];
  assert.deepEqual([Number(s.first_c), Number(s.first_ts)], [Number(firstLeft.c), Number(firstLeft.ts)], "first_c / first_ts follow");
  assert.equal(CV._rows.get(STD.id).first_ts, Number(firstLeft.ts), "...and the cached row");
  assert.equal(rep.merged, true);
  // the report
  const rs = roomOf(rep, STD), rp = roomOf(rep, PRIME);
  assert.equal(rs.deleted, 6, "2 chat + join + topic + 2 mic");
  assert.equal(rp.deleted, 1, "the 400-day-old 🎙 line");
  assert.equal(rs.tier, "standard"); assert.equal(rp.tier, "prime");
  assert.ok(!roomOf(rep, PLUS), "a room with nothing due isn't listed");
  // a second pass finds nothing more
  const again = await CP.run();
  assert.equal(roomOf(again, STD) ? roomOf(again, STD).deleted : 0, 0);
  // half an hour on, exp_* is the new cutoff exactly (the read side's own reconcile writes it only once it moved an hour)
  offset = 30 * 60e3;
  await CP.run();
  assert.ok(near((await roomRow(STD)).exp_chat, T() - 30 * D), "raised to the cutoff in the same pass");
  offset = 0;
  const pass = JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = 'purge_pass'"))[0].value);
  assert.ok(pass.at > 0 && pass.partial === false);
  const ev2 = await getQuery("SELECT * FROM room_events WHERE what = 'chatlog.purge'");
  assert.ok(ev2.some((e) => /deleted 7/.test(e.detail || "")), "the pass is audited (counts only)");
});

test("the fail-safes: no fresh report from Pepe, an unknown tier or tiers that can't be read delete nothing (and the purge raises no exp_*)", async () => {
  await ready();
  const R = { id: "Fs.Std", name: "Fs Std" };
  await seed(R, "standard", [["msg", "fsold1", 40 * D], ["tx", "fsold2", 45 * D], ["msg", "fsnew", H]]);
  const all = ["fsold1", "fsold2", "fsnew"];
  const raised = [];
  const realRaise = CV.raiseExp;
  CV.raiseExp = (id, cut) => { raised.push(id); return realRaise(id, cut); };
  // CL7 fix-up: the columns themselves are watched (a room nobody viewed since its windows moved: exp_* far behind the cutoff) -
  // the purge's own reconcile used to write them on a stale report (its lazy hour-step), with no raiseExp call to spy on
  const expCols = async () => { const r = await roomRow(R); return [Number(r.exp_chat), Number(r.exp_tx)]; };
  await runQuery("UPDATE chatlog_rooms SET exp_chat = 0, exp_tx = 0 WHERE room_id = ?", [R.id]);
  CV._rows.delete(R.id);
  try {
    // no report since the site started
    reportAt = () => null;
    let rep = await CP.run();
    assert.deepEqual([rep.mode, rep.why, rep.report_at], ["report", "stale_report", null]);
    assert.deepEqual(await texts(R), all);
    assert.equal(roomOf(rep, R).due, 2, "the report counts what a fresh pass would delete");
    assert.deepEqual(await expCols(), [0, 0], "no exp_* written on a stale report - not by the purge's reconcile either");
    // a report two hours old
    reportAt = () => T() - 2 * H;
    rep = await CP.run();
    assert.equal(rep.why, "stale_report");
    assert.deepEqual(await texts(R), all);
    assert.deepEqual(raised, [], "no exp_* raised on a stale report");
    assert.deepEqual(await expCols(), [0, 0]);
    // nor by a view meanwhile: the read side's lazy write waits for a fresh report (its floors still follow the tier at once)
    const V = await CV.view(R.id, { userId: "u_nobody" });
    assert.ok(near(V.floor.chat, T() - 30 * D), "visibility follows the window anyway");
    assert.deepEqual(await expCols(), [0, 0], "a view writes no exp_* on a stale report");
    // a tier change while the report is stale: the purge tracks nothing (the room reads as unknown); the 10-minute sweep does
    TIER.set(R.id, "prime");
    rep = await CP.run();
    assert.equal(roomOf(rep, R).unknown, true, "untracked tier change: the purge leaves the room alone");
    assert.equal(CV.tierOf(R.id).tier, "standard");
    TIER.set(R.id, "standard");
    reportAt = () => T() - 60e3;
    await CV.view(R.id, { userId: "u_nobody" });
    assert.ok(near((await expCols())[0], T() - 30 * D), "fresh again: the view's lazy write catches up");
    await runQuery("UPDATE chatlog_rooms SET exp_chat = 0, exp_tx = 0 WHERE room_id = ?", [R.id]);
    CV._rows.delete(R.id);
    // an unknown tier: the room is untouched (and listed)
    reportAt = () => T() - 60e3;
    TIER.set(R.id, "bogus");
    const exp0 = Number((await roomRow(R)).exp_chat);
    rep = await CP.run();
    assert.equal(rep.mode, "delete");
    assert.equal(roomOf(rep, R).unknown, true);
    assert.ok(rep.unknown >= 1);
    assert.deepEqual(await texts(R), all);
    assert.equal(Number((await roomRow(R)).exp_chat), exp0, "an unknown tier moves no watermark");
    assert.ok(!raised.includes(R.id));
  } finally { CV.raiseExp = realRaise; }
  let rep;
  // premium.js can't be loaded: every tier unknown
  TIER.set(R.id, "standard");
  const realEnsure = CV.ensurePremium;
  CV.ensurePremium = async () => false;
  try {
    rep = await CP.run();
    assert.deepEqual([rep.mode, rep.why], ["report", "tier_unknown"]);
    assert.deepEqual(await texts(R), all);
  } finally { CV.ensurePremium = realEnsure; }
  // all well again: they go
  rep = await CP.run();
  assert.equal(roomOf(rep, R).deleted, 2);
  assert.deepEqual(await texts(R), ["fsnew"]);
  await countersOk(R);
});

test("the purge switch off = report-only (exp_* still follows the cutoff); CL6's 30-day text removal runs whatever the mode; a recount touches nothing", async () => {
  await ready();
  const R = { id: "Off.Std", name: "Off Std" };
  const cs = await seed(R, "standard", [["msg", "offold1", 40 * D], ["msg", "offold2", 50 * D, BOB], ["msg", "offhid", 20 * D, CAROL], ["msg", "offnew", H]]);
  // a line a moderator hid 31 days ago (its appeal copy is due to go): taken down like chatlogmod's setRm
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:x', rm_why = 'test' WHERE c = ?", [T() - 31 * D, cs.offhid]);
  await runQuery("UPDATE chatlog_rooms SET idx_rows = idx_rows - 1 WHERE rk = ?", [await rkOf(R)]);
  // a recount: nothing deleted, blanked or raised by the purge; purge_pass (the schedule) untouched
  const passBefore = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'purge_pass'"))[0];
  const raised = [];
  const realRaise = CV.raiseExp;
  CV.raiseExp = (id, cut) => { raised.push(id); return realRaise(id, cut); };
  await runQuery("UPDATE chatlog_rooms SET exp_chat = 0, exp_tx = 0 WHERE room_id = ?", [R.id]);
  CV._rows.delete(R.id);
  let rep;
  try { rep = await CP.run({ dry: true }); } finally { CV.raiseExp = realRaise; }
  const e0 = await roomRow(R);
  assert.deepEqual([Number(e0.exp_chat), Number(e0.exp_tx)], [0, 0], "a recount writes no exp_* (CL7 fix-up: its reconcile neither)");
  assert.equal(rep.dry, true);
  assert.deepEqual([rep.mode, rep.why], ["report", "dry"]);
  assert.equal(roomOf(rep, R).due, 2);
  assert.equal((await texts(R)).length, 4, "a recount deletes nothing");
  assert.equal((await getQuery("SELECT text FROM chat_log WHERE c = ?", [cs.offhid]))[0].text, "offhid", "a recount blanks nothing");
  assert.deepEqual(raised, [], "a recount raises no exp_*");
  assert.deepEqual((await getQuery("SELECT value FROM chatlog_meta WHERE key = 'purge_pass'"))[0], passBefore);
  // the switch off
  await CL.setSwitch("purge", false, "test");
  try {
    const t = T();
    rep = await CP.run();
    assert.deepEqual([rep.mode, rep.why], ["report", "switch_off"]);
    assert.deepEqual((await texts(R)).filter((x) => x !== "msg"), ["offold1", "offold2", "offnew"], "nothing deleted");
    assert.equal(roomOf(rep, R).due, 2, "counted");
    assert.ok(near((await roomRow(R)).exp_chat, t - 30 * D), "exp_* follows the cutoff: hidden while purge is off");
    const h = (await getQuery("SELECT text, purged FROM chat_log WHERE c = ?", [cs.offhid]))[0];
    assert.deepEqual([h.text, h.purged], [null, 1], "the 30-day text removal ran anyway");
    assert.ok(rep.blanked >= 1);
    assert.equal(CL.policy && (await CL.policy()).purge, false, "the policy says deleted once deletion is on");
  } finally { await CL.setSwitch("purge", true, "test"); }
  rep = await CP.run();
  assert.equal(roomOf(rep, R).deleted, 2);
  assert.deepEqual((await texts(R)).filter((x) => x !== "msg"), ["offnew"]);
  await countersOk(R);
  await indexOk();
});

test("legal holds (a room; a speaker - their purged lines too) and open reports keep their lines; released, the next pass deletes them", async () => {
  await ready();
  const R = { id: "Hd.Std", name: "Hd Std" }, R2 = { id: "Hd.Room2", name: "Hd Room2" };
  const cs = await seed(R, "standard", [["msg", "hdalice", 40 * D, ALICE], ["msg", "hdbob", 40 * D, BOB], ["msg", "hdcarol", 40 * D, CAROL], ["tx", "hdcarolmic", 41 * D, CAROL],
                                        ["msg", "hddave", 40 * D, DAVE], ["msg", "hdnew", H, DAVE]]);
  await seed(R2, "standard", [["msg", "hdr2old", 40 * D, DAVE], ["msg", "hdr2new", H, DAVE]]);
  const rk = await rkOf(R), rk2 = await rkOf(R2);
  // carol's line was purged by staff (who -> h:<hash>): a hold on carol still covers it
  const row = (await getQuery("SELECT l.*, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.c = ?", [cs.hdcarol]))[0];
  await CLM.purgeRows([row], "staff:x", "test");
  assert.match((await getQuery("SELECT who FROM chat_log WHERE c = ?", [cs.hdcarol]))[0].who, /^h:[0-9a-f]{20}$/);
  const t = T();
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:alicecf', 'staff', 'test', ?), ('who:carolcf', 'staff', 'test', ?), (?, 'staff', 'test', ?)",
                 [t, t, "room:" + rk2, t]);
  await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created) VALUES (?, ?, 'u_x', 'harassment', NULL, 'open', ?)", [cs.hdbob, rk, t]);
  let rep = await CP.run();
  assert.deepEqual((await getQuery("SELECT c FROM chat_log WHERE rk = ? ORDER BY c", [rk])).map((x) => Number(x.c)),
                   [cs.hdalice, cs.hdbob, cs.hdcarol, cs.hdcarolmic, cs.hdnew], "only dave's old line went");
  assert.deepEqual((await texts(R2)), ["hdr2old", "hdr2new"], "a held room: nothing");
  const x = roomOf(rep, R);
  assert.deepEqual([x.deleted, x.kept.held, x.kept.reported, x.due], [1, 3, 1, 4]);
  assert.equal(roomOf(rep, R2).held_room, true);
  assert.equal(roomOf(rep, R2).kept.held, 1);
  const mark = JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", ["purge:" + rk]))[0].value);
  assert.equal(mark.kept, 4, "kept rows below the cutoff: the next pass rescans from the start");
  // released: the hold, the report decided
  await runQuery("DELETE FROM chatlog_holds");
  await runQuery("UPDATE chatlog_reports SET state = 'dismissed' WHERE c = ?", [cs.hdbob]);
  rep = await CP.run();
  assert.equal(roomOf(rep, R).deleted, 4);
  assert.equal(roomOf(rep, R2).deleted, 1);
  assert.deepEqual(await texts(R), ["hdnew"]);
  assert.deepEqual(await texts(R2), ["hdr2new"]);
  for (const r of [R, R2]) await countersOk(r);
  await indexOk();
});

test("batches: a keyset walk in (ts, c) - through equal times and kept rows - 1,000 a transaction by default; a slow batch halves the next", async () => {
  await ready();
  const R = { id: "Bt.Std", name: "Bt Std" };
  TIER.set(R.id, "standard");
  // 30 lines said in the same millisecond, 5 of a held speaker in between, all 45 days old - written as the archive writes them
  const ts = T() - 45 * D;
  let c = 50000000;
  const entries = [];
  for (let i = 0; i < 35; i++) {
    const held = i % 7 === 3;
    entries.push({ roomId: R.id, it: { c: ++c, ts, k: "msg", u: { login: held ? "heldguy" : "busyguy", display: held ? "Held" : "Busy" }, text: (held ? "btheld" : "btline") + i } });
  }
  entries.push({ roomId: R.id, it: { c: ++c, ts: T() - H, k: "msg", u: { login: "busyguy", display: "Busy" }, text: "btfresh" } });
  assert.equal((await CL.archiveBatch(entries)).written, 36);
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:heldguy', 'staff', 'test', ?)", [T()]);
  try {
    CP._setBatch(7);
    const rep = await CP.run();
    const x = roomOf(rep, R);
    assert.deepEqual([x.deleted, x.kept.held], [30, 5]);
    assert.ok(rep.batches >= 6, "35 rows, 7 a batch: " + rep.batches);
    assert.deepEqual((await texts(R)).filter((s) => !/^btheld/.test(s)), ["btfresh"]);
    assert.equal((await texts(R)).filter((s) => /^btheld/.test(s)).length, 5);
    await countersOk(R);
  } finally { await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:heldguy'"); }
  // 1,000 old rows; batches of 400 that are all "slow" (a budget below zero): 400 -> 200 -> 100, never under 100
  const more = [];
  for (let i = 0; i < 1000; i++) more.push({ roomId: R.id, it: { c: ++c, ts: ts + i, k: i % 5 ? "msg" : "tx", u: { login: "busyguy", display: "Busy" }, text: "bulk" + i } });
  assert.equal((await CL.archiveBatch(more)).written, 1000);
  CP._setBatch(400, -1);
  const rep = await CP.run();
  assert.equal(roomOf(rep, R).deleted, 1005, "the 1,000 + the 5 a hold no longer keeps");
  assert.equal(rep.batch_size, 100);
  assert.deepEqual(await texts(R), ["btfresh"]);
  await countersOk(R);
  await indexOk();
});

test("the report lists what each of the next 7 days would delete (admins only, on the card's API; a pass starts only from a same-origin fetch)", async () => {
  await ready();
  const R = { id: "Rp.Std", name: "Rp Std" };
  await seed(R, "standard", [["msg", "rp1", 29.5 * D], ["msg", "rp2", 28.5 * D], ["msg", "rp3", 27.5 * D], ["msg", "rp4", 26.5 * D], ["tx", "rp4mic", 26.5 * D],
                             ["msg", "rp5", 25.5 * D], ["msg", "rp6", 24.5 * D], ["msg", "rp7", 23.5 * D], ["msg", "rp8", 22.5 * D], ["msg", "rpnew", 10 * D]]);
  const rep = await CP.run();
  const x = roomOf(rep, R);
  assert.deepEqual(x.ahead, [1, 1, 1, 2, 1, 1, 1], "day by day");
  assert.equal(x.deleted, 0, "nothing is due yet");
  assert.equal((await texts(R)).length, 10);
  // the API
  for (const who of [null, STAFF]) assert.equal((await call("GET", "/api/admin/chatlog/purge", who)).status, 403);
  let r = await call("GET", "/api/admin/chatlog/purge", ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.d.switch, true);
  assert.equal(r.d.mode.mode, "delete");
  assert.deepEqual(roomOf(r.d.report, R).ahead, [1, 1, 1, 2, 1, 1, 1]);
  assert.ok(!JSON.stringify(r.d).includes("rp4mic"), "counts only - never a line");
  assert.equal((await call("POST", "/api/admin/chatlog/purge", STAFF, { action: "run" })).status, 403);
  assert.equal((await call("POST", "/api/admin/chatlog/purge", ADMIN, { action: "run" }, { csrf: false })).status, 403, "a same-origin fetch only");
  assert.equal((await call("POST", "/api/admin/chatlog/purge", ADMIN, { action: "nope" })).status, 400);
  r = await call("POST", "/api/admin/chatlog/purge", ADMIN, { action: "recount" });
  assert.deepEqual([r.status, r.d.started], [200, true]);
  for (let i = 0; i < 100 && CP.busy(); i++) await new Promise((res) => setTimeout(res, 20));
  r = await call("GET", "/api/admin/chatlog/purge", ADMIN);
  assert.equal(r.d.report.dry, true);
  assert.equal(r.d.report.by, "boss");
  // a day later (the clock moved) the first line is due and goes
  offset = 1 * D;
  const rep2 = await CP.run();
  assert.equal(roomOf(rep2, R).deleted, 1);
  assert.deepEqual(roomOf(rep2, R).ahead, [1, 1, 2, 1, 1, 1, 1]);
});

test("a refresh of a hidden person's names never loses one the purge took away (their lines gone, others' may still name them)", async () => {
  await ready();
  const R = { id: "Nm.Std", name: "Nm Std" };
  const HIDY = { id: "hidycf", login: "hidycf", display: "Hidalgo" };
  await seed(R, "standard", [["msg", "nmhidy", 40 * D, HIDY], ["msg", "nmabout", H, ALICE]]);
  await CL.hideNow(["hidycf"], "staff");
  await CV.refreshNames();
  const h = CL.hash("hidycf");
  assert.ok(CV._names.get(h) && CV._names.get(h).names.includes("Hidalgo"), JSON.stringify(CV._names.get(h)));
  await CP.run();
  assert.deepEqual(await texts(R), ["nmabout"], "their old line went");
  CV._disp.delete("hidycf");                      // (and no live roster remembers the name)
  CV._names.get(h).updated = 0;                   // due for a refresh
  await CV.refreshNames();
  assert.ok(CV._names.get(h).names.includes("Hidalgo"), "still redacted: " + JSON.stringify(CV._names.get(h)));
});

test("the schedule: once a night (06-10 UTC), any hour once 36 h passed, the next hourly check after a pass cut short", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(CP.dueAt(at("2026-10-20T12:00:00Z"), null), true, "never ran");
  assert.equal(CP.dueAt(at("2026-10-20T07:00:00Z"), { at: at("2026-10-19T07:30:00Z") }), true, "a night later");
  assert.equal(CP.dueAt(at("2026-10-20T07:00:00Z"), { at: at("2026-10-20T06:10:00Z") }), false, "already tonight");
  assert.equal(CP.dueAt(at("2026-10-20T13:00:00Z"), { at: at("2026-10-19T07:00:00Z") }), false, "the day after, outside the night");
  assert.equal(CP.dueAt(at("2026-10-20T20:00:00Z"), { at: at("2026-10-19T07:00:00Z") }), true, "37 h: any hour");
  assert.equal(CP.dueAt(at("2026-10-20T13:00:00Z"), { at: at("2026-10-20T11:55:00Z"), partial: true }), true, "cut short: the next hourly check");
  assert.equal(CP.dueAt(at("2026-10-20T12:20:00Z"), { at: at("2026-10-20T11:55:00Z"), partial: true }), false);
});

test("the downgrade grace: nothing past the lower tier goes for 30 days (an upgrade inside it keeps all), then it does; the report sees the grace end coming; exp_* only moves forward", async () => {
  await ready();
  const G = { id: "Gr.Down", name: "Gr Down" }, U = { id: "Gr.Up", name: "Gr Up" };
  const spec = [["msg", "old100", 100 * D], ["msg", "old40", 40 * D], ["tx", "mic100", 100 * D], ["msg", "new2", 2 * D]];
  await seed(G, "prime", spec.map(([k, w, a]) => [k, "gd" + w, a]));
  await seed(U, "prime", spec.map(([k, w, a]) => [k, "gu" + w, a]));
  let rep = await CP.run();                          // tracked as Prime Time: nothing due (chat for good, 🎙 365 days)
  assert.equal((await texts(G)).length, 4);
  // both lapse to no tier now
  TIER.set(G.id, "standard"); TIER.set(U.id, "standard");
  const t0 = T();
  rep = await CP.run();
  const g = roomOf(rep, G);
  assert.deepEqual([g.tier, g.del_tier, g.deleted], ["standard", "prime", 0], "inside the grace: deletes like Prime Time");
  assert.ok(near(g.grace_until, t0 + 30 * D));
  assert.deepEqual(g.ahead, [0, 0, 0, 0, 0, 0, 0]);
  assert.equal((await texts(G)).length, 4);
  // 10 days on, U is upgraded back (inside its grace)
  offset = 10 * D;
  TIER.set(U.id, "prime");
  await CP.run();
  // 25 days on: the grace ends within the week - the report shows the backlog on that day
  offset = 25 * D;
  rep = await CP.run();
  const g25 = roomOf(rep, G);
  assert.equal(g25.deleted, 0);
  const due = g25.ahead.findIndex((n) => n > 0);
  assert.ok(due >= 4 && due <= 5, "the grace ends on day 5 or 6: " + JSON.stringify(g25.ahead));
  assert.equal(g25.ahead[due], 4, "everything older than 30 days by then, at once (chat and 🎙)");
  assert.equal(g25.ahead.reduce((a, b) => a + b, 0), 4);
  const expBefore = Number((await roomRow(G)).exp_chat);
  // 31 days on: the grace is over - no tier: chat and 🎙 past 30 days go; U (upgraded inside its grace) keeps everything
  offset = 31 * D;
  await seed(G, null, [["msg", "gdfresh", H]]);
  const t31 = T();
  rep = await CP.run();
  assert.equal(roomOf(rep, G).deleted, 4);
  assert.deepEqual(await texts(G), ["gdfresh"]);
  assert.equal((await texts(U)).length, 4, "upgraded inside the grace: nothing lost");
  const s = await roomRow(G);
  assert.ok(near(s.exp_chat, t31 - 30 * D) && Number(s.exp_chat) >= expBefore, JSON.stringify(s));
  // an upgrade after the grace: the cutoff falls back to 0 (for good), exp_* never does
  TIER.set(G.id, "unlimited");
  rep = await CP.run();
  assert.equal(roomOf(rep, G) ? roomOf(rep, G).deleted : 0, 0);
  const after = await roomRow(G);
  assert.ok(Number(after.exp_chat) >= Number(s.exp_chat) && near(after.exp_chat, s.exp_chat), "exp_* only moves forward: " + JSON.stringify(after));
  assert.deepEqual(await CV.raiseExp(G.id, { chat: 1, tx: 1 }), { chat: Number(after.exp_chat), tx: Number(after.exp_tx) });
  assert.equal(await CV.raiseExp("No.Such.Room", { chat: T(), tx: T() }), null, "never makes a row");
  await countersOk(G);
  await indexOk();
});

// ── CL7 fix-up ──

test("a second downgrade inside a grace keeps its own 30 days: Plus -> Prime Time, then Prime Time -> none on day 29 keeps Prime Time's windows until day 59", async () => {
  await ready();
  const R = { id: "Dd.Dbl", name: "Dd Dbl" };
  await seed(R, "unlimited", [["msg", "ddchat100", 100 * D], ["msg", "ddchat40", 40 * D], ["tx", "ddmic400", 400 * D], ["tx", "ddmic100", 100 * D]]);
  await CP.run();                                    // tracked as 💎 Plus
  TIER.set(R.id, "prime");                           // day 0: Plus lapses to Prime Time
  const t0 = T();
  await CP.run();
  assert.deepEqual(CV.tierOf(R.id).lapsed, [{ tier: "unlimited", at: CV.tierOf(R.id).lapsed[0].at }]);
  assert.ok(near(CV.tierOf(R.id).lapsed[0].at, t0));
  offset = 29 * D;                                   // day 29: Prime Time lapses to no tier
  TIER.set(R.id, "standard");
  const t29 = T();
  let rep = await CP.run();
  const T29 = CV.tierOf(R.id);
  assert.deepEqual(T29.lapsed.map((e) => e.tier), ["unlimited", "prime"], "both lapses tracked, each with its own start");
  assert.ok(near(T29.lapsed[0].at, t0) && near(T29.lapsed[1].at, t29));
  assert.deepEqual([T29.prev, T29.tier], ["prime", "standard"]);
  assert.equal(roomOf(rep, R).deleted, 0, "inside Plus's grace: nothing");
  assert.equal(roomOf(rep, R).del_tier, "unlimited");
  // the stored record carries them (a restart reads the same)
  const stored = JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", ["tier:" + R.id]))[0].value);
  assert.deepEqual(stored.lapsed.map((e) => e.tier), ["unlimited", "prime"]);
  // day 31: Plus's grace is over, Prime Time's (from day 29) is not - chat for good, 🎙 365 days: only the 431-day-old 🎙 line goes
  offset = 31 * D;
  rep = await CP.run();
  let x = roomOf(rep, R);
  assert.equal(x.deleted, 1, JSON.stringify(x));
  assert.deepEqual(await texts(R), ["ddchat100", "ddchat40", "ddmic100"], "Prime Time's windows hold for 30 days from the SECOND drop");
  assert.deepEqual([x.del_tier, x.lapsed.length], ["prime", 1]);
  assert.ok(near(x.grace_until, t29 + 30 * D));
  const ex = await roomRow(R);
  assert.ok(Number(ex.exp_chat) === 0 && near(ex.exp_tx, T() - 365 * D), "exp_* follows Prime Time's cutoff, not the free one: " + JSON.stringify(ex));
  // day 55: the grace's end shows up in the 7-day look-ahead (everything older than 30 days by then, at once)
  offset = 55 * D;
  rep = await CP.run();
  x = roomOf(rep, R);
  assert.equal(x.deleted, 0);
  assert.equal(x.ahead.reduce((a, b) => a + b, 0), 3, JSON.stringify(x.ahead));
  // day 60: Prime Time's grace is over too - the free windows
  offset = 60 * D;
  await seed(R, null, [["msg", "ddfresh", H]]);
  rep = await CP.run();
  assert.equal(roomOf(rep, R).deleted, 3);
  assert.deepEqual(await texts(R), ["ddfresh"]);
  // a record from before the fix-up ({prev, drop_at}) reads as that one lapse
  assert.deepEqual(CV.lapsedOf({ tier: "standard", prev: "prime", drop_at: 123 }), [{ tier: "prime", at: 123 }]);
  assert.deepEqual(CV.graceOf({ tier: "standard", prev: "prime", drop_at: 1000 }, 1000 + 29 * D).map((e) => e.tier), ["prime"]);
  assert.deepEqual(CV.graceOf({ tier: "standard", prev: "prime", drop_at: 1000 }, 1000 + 30 * D), []);
  await countersOk(R);
  await indexOk();
  freeRooms(R);
});

test("a legal hold or an open report that comes in WHILE a pass runs is honoured (read per batch, not a snapshot from the pass's start)", async () => {
  await ready();
  const A = { id: "Mh.A", name: "Mh A" }, B = { id: "Mh.B", name: "Mh B" }, C = { id: "Mh.C", name: "Mh C" }, E = { id: "Mh.E", name: "Mh E" };
  await seed(A, "standard", [["msg", "mhaold", 40 * D, BOB]]);
  await seed(B, "standard", [["msg", "mhbold", 40 * D, DAVE], ["msg", "mhbnew", H, DAVE]]);
  const cc = await seed(C, "standard", [1, 2, 3, 4, 5, 6].map((i) => ["msg", "mhc" + i, (40 + i) * D, CAROL]));
  const ce = await seed(E, "standard", [1, 2, 3, 4].map((i) => ["msg", "mhe" + i, (40 + i) * D, ALICE]));
  const rkC = await rkOf(C), rkE = await rkOf(E);
  // 1. staff hold dave at the start of the pass (the per-login tool's write - before chatlogmod has even reloaded its holds)
  const realRec = CV.reconcileNow;
  let placed = false;
  CV.reconcileNow = async (id, o) => {
    if (!placed) { placed = true; await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:davecf', 'staff', 'subpoena', ?)", [T()]); }
    return realRec(id, o);
  };
  // 2. a room hold on C after its first batch; 3. an open report on one of E's lines after its first batch
  CP._setBatch(2);
  const seen = new Map();
  CP._onBatch(async ({ rk }) => {
    const n = (seen.get(rk) || 0) + 1;
    seen.set(rk, n);
    if (rk === rkC && n === 2) await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, 'staff', 'order', ?)", ["room:" + rkC, T()]);
    if (rk === rkE && n === 2) {
      await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created) VALUES (?, ?, 'u_x', 'harassment', NULL, 'open', ?)", [ce.mhe1, rkE, T()]);
    }
  });
  let rep;
  try { rep = await CP.run(); } finally { CV.reconcileNow = realRec; CP._onBatch(null); CP._setBatch(0); }
  assert.deepEqual(await texts(A), [], "bob (no hold) went");
  assert.deepEqual(await texts(B), ["mhbold", "mhbnew"], "dave's old line stays: the hold came in after the pass started");
  assert.equal(roomOf(rep, B).kept.held, 1);
  // C: the first batch (the two oldest) went before the hold; the rest stays, the room reads as held, and its mark rescans it
  assert.deepEqual(await texts(C), ["mhc1", "mhc2", "mhc3", "mhc4"]);
  assert.ok(cc.mhc5 > 0 && cc.mhc6 > 0);
  assert.equal(roomOf(rep, C).held_room, true);
  assert.equal(roomOf(rep, C).deleted, 2);
  assert.ok(JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", ["purge:" + rkC]))[0].value).kept > 0);
  // E: the reported line (said 41 days ago - the second batch's) stays, the others went
  assert.deepEqual(await texts(E), ["mhe1"]);
  assert.equal(roomOf(rep, E).kept.reported, 1);
  // released: the next pass deletes them
  await runQuery("DELETE FROM chatlog_holds");
  await runQuery("UPDATE chatlog_reports SET state = 'dismissed' WHERE c = ?", [ce.mhe1]);
  await CLM.loadHolds();
  await CP.run();
  assert.deepEqual(await texts(B), ["mhbnew"]);
  assert.deepEqual(await texts(C), []);
  assert.deepEqual(await texts(E), []);
  for (const r of [A, B, C, E]) await countersOk(r);
  freeRooms(A, B, C, E);
});

test("a pass that couldn't delete (Pepe's report stale, tiers unknown, a failure) doesn't use up the night: the next hourly check retries once it can", async () => {
  await ready();
  const R = { id: "Rt.Std", name: "Rt Std" };
  await seed(R, "standard", [["msg", "rtold", 40 * D], ["msg", "rtnew", H]]);
  const lastPass = async () => JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = 'purge_pass'"))[0].value);
  // a night-time pass while Pepe's report is stale (or "Run tonight's pass now" in the daytime): report-only, marked for a retry
  reportAt = () => null;
  let rep = await CP.run({ manual: true, by: "boss" });
  assert.deepEqual([rep.mode, rep.why, rep.retry], ["report", "stale_report", true]);
  let p = await lastPass();
  assert.deepEqual([p.retry, p.why], [true, "stale_report"]);
  assert.equal(CP.dueAt(p.at + 30 * 60e3, p), false);
  assert.equal(CP.dueAt(p.at + CP.CHECK_MS, p), true, "the next hourly check");
  // an hour on, still stale: the check runs no pass (nothing would be deleted)
  offset = H;
  assert.equal(await CP.checkNow(), null);
  assert.equal((await lastPass()).at, p.at, "no pass ran");
  assert.deepEqual(await texts(R), ["rtold", "rtnew"]);
  // two hours on, Pepe reported: the check runs the pass and the line goes
  offset = 2 * H;
  reportAt = () => T() - 60e3;
  rep = await CP.checkNow();
  assert.ok(rep && rep.mode === "delete", JSON.stringify(rep && rep.why));
  assert.deepEqual(await texts(R), ["rtnew"]);
  p = await lastPass();
  assert.equal(p.retry, false);
  assert.equal(CP.dueAt(p.at + CP.CHECK_MS, p), false, "back to once a night");
  // the switch off is the owner's choice: no retry
  await CL.setSwitch("purge", false, "test");
  try { rep = await CP.run(); } finally { await CL.setSwitch("purge", true, "test"); }
  assert.deepEqual([rep.why, rep.retry], ["switch_off", false]);
  // tiers unknown, and a pass that failed before the rooms were done: retried
  const realEnsure = CV.ensurePremium;
  CV.ensurePremium = async () => false;
  try { rep = await CP.run(); } finally { CV.ensurePremium = realEnsure; }
  assert.deepEqual([rep.why, rep.retry], ["tier_unknown", true]);
  const realLoad = CLM.loadHolds;
  CLM.loadHolds = async () => { throw new Error("database is locked"); };
  try { rep = await CP.run(); } finally { CLM.loadHolds = realLoad; }
  assert.deepEqual([rep.mode, rep.failed, rep.retry], ["delete", true, true]);
  assert.equal((await lastPass()).retry, true);
  freeRooms(R);
});

test("the wall clock's sanity check: a clock behind the last pass deletes nothing and re-bases the schedule; a step against the monotonic clock holds deletion a day", async () => {
  await ready();
  const R = { id: "Ck.Std", name: "Ck Std" };
  await seed(R, "standard", [["msg", "ckold1", 40 * D], ["msg", "cknew", H]]);
  const expOf = async () => Number((await roomRow(R)).exp_chat);
  // the last pass is two days in the future (the clock went back - or that pass ran on a clock that had jumped ahead)
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('purge_pass', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 [JSON.stringify({ at: T() + 2 * D, partial: false })]);
  assert.equal(CP.dueAt(T(), { at: T() + 2 * D }), true, "the schedule doesn't stall until the clock catches up");
  assert.equal(CP.dueAt(T(), { at: T() + 5 * 60e3 }), false, "(minutes ahead: not yet)");
  const m = await CP.modeNow();
  assert.deepEqual([m.mode, m.why, m.permanent], ["report", "clock_back", false]);
  const e0 = await expOf();
  let rep = await CP.run();
  assert.equal(rep.why, "clock_back");
  assert.deepEqual(await texts(R), ["ckold1", "cknew"]);
  assert.equal(await expOf(), e0, "and nothing permanent moved");
  const p = JSON.parse((await getQuery("SELECT value FROM chatlog_meta WHERE key = 'purge_pass'"))[0].value);
  assert.ok(near(p.at, T()), "the schedule re-based on the clock now");
  rep = await CP.run();
  assert.equal(rep.mode, "delete", "the next pass deletes again");
  assert.deepEqual(await texts(R), ["cknew"]);
  // a step: the wall clock moves 3 hours while the monotonic clock moves a second (another room: R's scan resumes above its mark)
  const R2 = { id: "Ck.Two", name: "Ck Two" };
  const c2 = await seed(R2, "standard", [["msg", "ckold2", 40 * D], ["msg", "cknew2", H], ["msg", "ckhid", 20 * D, CAROL]]);
  // (and a line a moderator hid 31 days ago: the 30-day text removal waits for a sane clock too)
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:x', rm_why = 'test' WHERE c = ?", [T() - 31 * D, c2.ckhid]);
  const hidText = async () => (await getQuery("SELECT text FROM chat_log WHERE c = ?", [c2.ckhid]))[0].text;
  let w = 1e12, mono = 5000;
  CP._setClockSource({ wall: () => w, mono: () => mono });
  w += 60e3; mono += 60e3;                           // (an ordinary minute: no step)
  assert.equal((await CP.modeNow()).mode, "delete");
  w += 3 * H; mono += 1000;
  const m2 = await CP.modeNow();
  assert.deepEqual([m2.mode, m2.why, m2.permanent], ["report", "clock", false]);
  assert.ok(Math.abs(m2.clock_step.ms - (3 * H - 1000)) < 5);
  rep = await CP.run();
  assert.deepEqual([rep.why, rep.retry], ["clock", true]);
  assert.deepEqual(await texts(R2), ["ckold2", "cknew2", "ckhid"], "held");
  assert.equal(await hidText(), "ckhid", "no 30-day text removal on a stepped clock");
  w += 23 * H; mono += 23 * H;                       // a steady clock, but still inside the day's hold
  assert.equal((await CP.modeNow()).why, "clock");
  w += 2 * H; mono += 2 * H;
  assert.equal((await CP.modeNow()).mode, "delete", "a day of a steady clock: deleting again");
  // a step back counts the same (a clock put right after a glitch moves forward again)
  w -= 2 * H; mono += 1000;
  assert.equal((await CP.modeNow()).why, "clock");
  CP._setClockSource();
  rep = await CP.run();
  assert.equal(rep.mode, "delete");
  assert.deepEqual(await texts(R2), ["cknew2", "msg"]);
  assert.equal(await hidText(), null, "the clock sane again: blanked");
  assert.equal(CP.CLOCK_HOLD_MS, 24 * H);
  freeRooms(R, R2);
});

test("a room is purged whatever its rows counter says (drift to 0 never skips it for good)", async () => {
  await ready();
  const R = { id: "Dr.Std", name: "Dr Std" };
  await seed(R, "standard", [["msg", "drold", 40 * D], ["msg", "drnew", H]]);
  await runQuery(`UPDATE chatlog_rooms SET "rows" = 0 WHERE room_id = ?`, [R.id]);
  const rep = await CP.run();
  assert.equal(roomOf(rep, R).deleted, 1);
  assert.deepEqual(await texts(R), ["drnew"]);
  freeRooms(R);
});

test("lines the archive never kept leave bridge_feed and the live feed by the same cutoffs (holds kept); the takedown ring isn't flooded; first_c clears when no line is left", async () => {
  await ready();
  const F = { id: "Fd.Std", name: "Fd Std" };
  const cs = await seed(F, "standard", [["msg", "fdarch", 40 * D], ["msg", "fdnew", H]]);
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:heldguy2', 'staff', 'test', ?)", [T()]);
  const old = T() - 40 * D;
  const rows = [
    [70000001, old, { ts: old, k: "msg", u: { login: "alicecf", display: "Alice" }, text: "fdpre1" }],            // before the seed: goes
    [70000002, old, { ts: old, k: "tx", u: { login: "alicecf", display: "Alice" }, text: "fdpre2", id: "tx-fd2" }], // a 🎙 line: goes
    [70000003, T() - 10 * D, { ts: T() - 10 * D, k: "msg", u: { login: "alicecf", display: "Alice" }, text: "fdin" }], // inside retention
    [70000004, old, { ts: old, k: "msg", u: { login: "heldguy2", display: "Held" }, text: "fdheld" }],             // a held speaker
    [70000005, old, { ts: old, k: "msg", u: { anon: true }, ah: CL.hash("heldguy2"), text: "fdheldanon" }],      // ...said incognito
  ];
  for (const [c, ts, data] of rows) await runQuery("INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (?, ?, ?, ?)", [c, F.id, ts, JSON.stringify(data)]);
  const RF = bridge._rooms.get(F.id);
  RF.feed.push(Object.assign({ c: 70000001 }, rows[0][2]));
  let rep;
  try { rep = await CP.run(); } finally { await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:heldguy2'"); }
  const left = (await getQuery("SELECT c FROM bridge_feed WHERE room_id = ? ORDER BY c", [F.id])).map((r) => Number(r.c));
  assert.deepEqual(left, [cs.fdnew, 70000003, 70000004, 70000005], "the archived line went with its row, the never-archived ones by age");
  assert.equal(roomOf(rep, F).deleted, 1);
  assert.equal(roomOf(rep, F).feed_deleted, 2);
  assert.ok(!RF.feed.some((it) => Number(it.c) === 70000001 || Number(it.c) === cs.fdarch), "and from the live feed");
  // the takedown ring: a moderator's takedown of the last hour stays in it after a purge of hundreds of old live lines
  const Q = { id: "Rg.Std", name: "Rg Std" };
  const spec = [];
  for (let i = 0; i < 210; i++) spec.push(["msg", "rgold" + i, 40 * D + i * 1000]);
  spec.push(["msg", "rgfresh", H]);
  const qc = await seed(Q, "standard", spec);
  const RQ = bridge._rooms.get(Q.id);
  assert.equal(RQ.feed.length, 200);
  await bridge.takeDown(Q.id, [qc.rgfresh]);
  assert.deepEqual(RQ.removed.map((x) => x.c), [qc.rgfresh]);
  rep = await CP.run();
  assert.equal(roomOf(rep, Q).deleted, 210);
  assert.equal(RQ.feed.length, 0, "the old lines left the live feed");
  assert.deepEqual(RQ.removed.map((x) => x.c), [qc.rgfresh], "the ring holds the moderator's takedown - and no retention drop");
  // every line of a room gone: its first line clears (the next line written sets it again)
  const Z = { id: "Zz.Std", name: "Zz Std" };
  await seed(Z, "standard", [["msg", "zzold", 40 * D]]);
  await CV.view(Z.id, { userId: "u_nobody" });
  await CP.run();
  const z = await roomRow(Z);
  assert.deepEqual([z.first_c, z.first_ts, Number(z.rows)], [null, null, 0]);
  assert.equal(CV._rows.get(Z.id).first_ts, null, "the cached row too");
  const zc = await seed(Z, null, [["msg", "zznew", H]]);
  assert.equal(Number((await roomRow(Z)).first_c), zc.zznew);
  for (const r of [F, Q, Z]) await countersOk(r);
});
