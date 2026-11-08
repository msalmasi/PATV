// pttlimits (the owner, 2026-11-08: "is there somewhere I can quickly change the cooldown for the push to talk (relayed mic) from
// bridge, and somewhere I can set the max length"): the 🎙 push-to-talk clip limits were constants (bridge-relay CLIP_PLAY 30 s /
// 3 per 10 min, CLIP_MAX_SECS 30, a 600 KB body cap; the recorder stopped at 20 s and said "up to 20 s"). Now they are one admin
// setting, the "Push-to-talk clips" card on /admin/bridge (pttlimits.js; chatlog_meta 'ptt_limits', audited pttlimits.save):
//   * cooldown between a person's clips (gap_s, 0-600, default 30), clips per 10 minutes per person (burst, 1-30, default 3),
//     max clip length (max_secs, 3-120, default 30) - admins only, a same-origin fetch, every change an admin_audit row
//   * the site enforces them at once (no restart): the play limit, the length check, a byte cap that grows with the length (with a
//     hard ceiling), the flood guard never below the per-10-minute number
//   * every clip job carries them for Pepe: max_secs, gap_s, burst, window_s (the values the clip was accepted under)
//   * the page gets the max length with the live view (room.pttMax); the recorder stops there and says the real number
// Review fixes:
//   1. an older Pepe refuses (and CHARGES, bad_clip) any clip over his own 30 s - so a max length over 30 applies only while Pepe
//      says he follows the job's limits (ptt_limits: 1 on his pull / sync, seen in the last PEPE_TTL); until then the site, the
//      recorder and the job keep a clip to 30 s (the card says which)
//   2. nginx in front of the site takes at most 1 MB (client_max_body_size 1m, botupload.js): the byte cap stays under it, and the
//      page words ANY 413 (nginx's HTML one too) as "too big", not "couldn't reach the site"
//      (2026-11-08: nginx takes 4 MB on POST /api/rooms/<slug>/clip only - the cap is (max + 1 s) x 24 KB/s, 600 KB..3.5 MB, under
//      nginx's 4 MB and under Pepe's own cap for each max length; the body is re-checked against the length its job carries)
//   3. the recorder stops 0.5 s before the max length and never sends one that ran over max + 0.5 s (Pepe's own check)
//   4. a clip Pepe said is playing gets its own length + 90 s to say how it went (a 120 s clip isn't failed mid-play)
//   node --test test/pttlimits.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pttlimits-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const relay = require(path.join(repo, "bridge-relay"));
const PT = require(path.join(repo, "pttlimits"));

const R = { id: "Room.PttLim", slug: "room-pttlim", micRelay: true, relay: true, members: [], cmds: {} };
const users = new Map([
  ["boss", { userId: "boss", username: "boss", class: "Admin" }],
  ["helper", { userId: "helper", username: "helper", class: "Staff" }],
  ["p1", { userId: "p1", username: "p1_patv", class: "pleb" }],
]);
let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('p1', 'p1_patv', 'p1', 'x', 'pleb', 'alice')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('boss', 'boss', 'boss', 'x', 'Admin')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('helper', 'helper', 'helper', 'x', 'Staff')");
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  relay.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug: (s) => (s === R.slug ? R : null), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await PT.init();
});
test.after(() => server.close());

const reset = () => { relay._hits.clear(); relay._jobs.clear(); };
async function api(method, who, body, headers = {}) {
  const h = Object.assign({}, who ? { "x-test-user": who } : {}, body ? { "content-type": "application/json" } : {}, headers);
  const r = await fetch(base + "/api/admin/pttlimits", { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const save = (body, who = "boss") => api("POST", who, body, { "x-requested-with": "fetch" });
async function setLimits(cfg) {
  const r = await save(cfg);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d;
}
async function upload(secs = 3, body = Buffer.alloc(2000, 1)) {
  const r = await fetch(base + "/api/rooms/" + R.slug + "/clip", { method: "POST",
    headers: { "content-type": "audio/webm", "x-clip-secs": String(secs), "x-test-user": "p1" }, body });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
// review fix 1: Pepe's long-poll saying he follows each clip job's limits (ptt_limits: 1); flag = null -> an older Pepe's pull
async function pepeSays(flag = 1) {
  const r = await fetch(base + "/api/bridge/relay/pull", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ password: "bot-token", wait: 0, acks: [] }, flag == null ? {} : { ptt_limits: flag })) });
  assert.equal(r.status, 200);
  await r.json();
}

// ── the setting ──

test("defaults are today's limits: 30 s cooldown, 3 per 10 min, 30 s long", () => {
  PT._reset();
  assert.deepEqual(PT.DEFAULTS, { gap_s: 30, burst: 3, max_secs: 30 });
  assert.equal(PT.WINDOW_S, 600);
  assert.deepEqual(PT.current(), { gap_s: 30, burst: 3, max_secs: 30, window_s: 600 }, "before the row is read: the defaults");
});

test("admin API: site admins only (by the account's class in the database), a same-origin fetch for a change", async () => {
  await PT.init();
  assert.equal((await api("GET", null)).status, 401);
  assert.equal((await api("GET", "p1")).status, 403);
  assert.equal((await api("GET", "helper")).status, 403, "staff can't");
  const g = await api("GET", "boss");
  assert.equal(g.status, 200, JSON.stringify(g.d));
  assert.deepEqual(g.d.cfg, { gap_s: 30, burst: 3, max_secs: 30 });
  assert.deepEqual(g.d.defaults, { gap_s: 30, burst: 3, max_secs: 30 });
  assert.deepEqual(g.d.limits, { gap_s: [0, 600], burst: [1, 30], max_secs: [3, 120] });
  assert.equal(g.d.window_s, 600);
  // a change: no X-Requested-With -> refused; another site's Origin -> refused; staff / members -> refused
  assert.equal((await api("POST", "boss", { gap_s: 10 })).status, 403);
  assert.equal((await api("POST", "boss", { gap_s: 10 }, { "x-requested-with": "fetch", origin: "https://evil.example" })).status, 403);
  assert.equal((await save({ gap_s: 10 }, "helper")).status, 403);
  assert.equal((await save({ gap_s: 10 }, "p1")).status, 403);
  assert.equal((await api("POST", null, { gap_s: 10 }, { "x-requested-with": "fetch" })).status, 401);
  assert.equal(PT.current().gap_s, 30, "nothing changed");
  // a JWT that still says Admin for an account demoted since: the database's class decides
  users.set("demoted", { userId: "helper", username: "helper", class: "Admin" });
  assert.equal((await save({ gap_s: 10 }, "demoted")).status, 403);
  assert.equal(PT.current().gap_s, 30);
});

test("validation: whole numbers inside each range, else 400 naming the field - nothing saved", async () => {
  const bad = [
    [{ gap_s: -1 }, "gap_s"], [{ gap_s: 601 }, "gap_s"], [{ gap_s: 2.5 }, "gap_s"], [{ gap_s: "abc" }, "gap_s"],
    [{ burst: 0 }, "burst"], [{ burst: 31 }, "burst"], [{ burst: null }, "burst"],
    [{ max_secs: 2 }, "max_secs"], [{ max_secs: 121 }, "max_secs"], [{ max_secs: "" }, "max_secs"],
  ];
  for (const [body, field] of bad) {
    const r = await save(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.d.field, field, JSON.stringify(body));
    assert.ok(r.d.error && r.d.error.length > 5, "a reason the card can show");
  }
  assert.deepEqual(PT.current(), { gap_s: 30, burst: 3, max_secs: 30, window_s: 600 }, "nothing changed");
  assert.equal((await save({})).status, 400, "nothing to save");
  // numbers typed into the form arrive as strings - "45" is fine
  const ok = await save({ gap_s: "45", burst: "4", max_secs: "60" });
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  assert.deepEqual(PT.current(), { gap_s: 45, burst: 4, max_secs: 60, window_s: 600 });
  // edges
  await setLimits({ gap_s: 0, burst: 1, max_secs: 3 });
  assert.deepEqual(PT.current(), { gap_s: 0, burst: 1, max_secs: 3, window_s: 600 });
  await setLimits({ gap_s: 600, burst: 30, max_secs: 120 });
  assert.deepEqual(PT.current(), { gap_s: 600, burst: 30, max_secs: 120, window_s: 600 });
  await setLimits({ reset: true });
  assert.deepEqual(PT.current(), { gap_s: 30, burst: 3, max_secs: 30, window_s: 600 }, "reset = the defaults");
});

test("a save persists (chatlog_meta 'ptt_limits'), is audited (admin_audit pttlimits.save), survives a restart; a bad row is clamped", async () => {
  const before = (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'pttlimits.save'"))[0].n;
  const r = await save({ gap_s: 12, burst: 5, max_secs: 45, reason: "louder rooms tonight" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.cfg, { gap_s: 12, burst: 5, max_secs: 45 });
  assert.deepEqual(r.d.changed, { gap_s: [30, 12], burst: [3, 5], max_secs: [30, 45] });
  const row = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'ptt_limits'"))[0];
  const v = JSON.parse(row.value);
  assert.deepEqual([v.gap_s, v.burst, v.max_secs, v.by], [12, 5, 45, "boss"]);
  const a = await getQuery("SELECT * FROM admin_audit WHERE action = 'pttlimits.save' ORDER BY id DESC");
  assert.equal(a.length, before + 1);
  assert.equal(a[0].admin_name, "boss");
  assert.equal(a[0].reason, "louder rooms tonight");
  assert.deepEqual(JSON.parse(a[0].detail).to, { gap_s: 12, burst: 5, max_secs: 45 });
  // the same values again: no write, no audit row
  const again = await save({ gap_s: 12, burst: 5, max_secs: 45 });
  assert.equal(again.status, 200);
  assert.equal(again.d.unchanged, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'pttlimits.save'"))[0].n, before + 1);
  // the card's GET shows them, who changed them, and the recent changes
  const g = await api("GET", "boss");
  assert.deepEqual(g.d.cfg, { gap_s: 12, burst: 5, max_secs: 45 });
  assert.equal(g.d.by, "boss");
  assert.ok(g.d.at > 0);
  assert.ok(Array.isArray(g.d.audit) && g.d.audit.length >= 1);
  // a restart reads them back
  PT._reset();
  await PT.init();
  assert.deepEqual(PT.current(), { gap_s: 12, burst: 5, max_secs: 45, window_s: 600 });
  // a row out of range (written by hand) can't break a clip: each value is clamped on the way out
  await runQuery("UPDATE chatlog_meta SET value = ? WHERE key = 'ptt_limits'", [JSON.stringify({ gap_s: 99999, burst: -4, max_secs: "x" })]);
  PT._reset();
  await PT.init();
  assert.deepEqual(PT.current(), { gap_s: 600, burst: 1, max_secs: 30, window_s: 600 });
  await setLimits({ reset: true });
});

// ── enforcement ──

test("the play limit follows the setting at once: no cooldown + 5 per 10 min, then a 10 s cooldown", async () => {
  reset();
  await setLimits({ gap_s: 0, burst: 5, max_secs: 30 });
  for (let i = 0; i < 5; i++) assert.equal((await upload()).status, 200, "clip " + (i + 1));
  const sixth = await upload();
  assert.equal(sixth.status, 429);
  assert.match(sixth.d.error, /5 per 10 min/);
  reset();
  await setLimits({ gap_s: 10, burst: 5, max_secs: 30 });
  assert.equal((await upload()).status, 200);
  const next = await upload();
  assert.equal(next.status, 429);
  assert.match(next.d.error, /one every 10s/);
  // the hit history is kept across a change: lowering the cooldown frees the next clip at once
  await setLimits({ gap_s: 0, burst: 5, max_secs: 30 });
  assert.equal((await upload()).status, 200);
  await setLimits({ reset: true });
  reset();
  assert.equal((await upload()).status, 200);
  assert.match((await upload()).d.error, /one every 30s/, "the default again");
});

test("the flood guard is never below the per-10-minute number (12, or more when clips per 10 min is higher)", async () => {
  reset();
  await setLimits({ gap_s: 0, burst: 20, max_secs: 30 });
  for (let i = 0; i < 20; i++) assert.equal((await upload()).status, 200, "clip " + (i + 1));
  const over = await upload();
  assert.equal(over.status, 429);
  assert.match(over.d.error, /20 per 10 min/);
  // clips that didn't play are given back - the flood guard (uploads, played or not) still stops at max(12, burst)
  reset();
  for (let i = 0; i < 20; i++) {
    const r = await upload();
    assert.equal(r.status, 200, "upload " + (i + 1));
    relay.takeJobs(new Set([R.id]));
    relay.applyAcks([{ id: r.d.id, ok: false, msg: "Pepe couldn't get the mic - no cooldown - try again", code: "no_mic" }]);
  }
  const flood = await upload();
  assert.equal(flood.status, 429);
  assert.match(flood.d.error, /20 clips per 10 min, played or not/);
  await setLimits({ reset: true });
});

test("max length: the setting, +1 s for the recorder's stop; the refusal names it", async () => {
  reset();
  await setLimits({ gap_s: 0, burst: 30, max_secs: 30 });
  assert.equal((await upload(31)).status, 200);
  let r = await upload(31.5);
  assert.equal(r.status, 400);
  assert.equal(r.d.code, "too_long");
  assert.equal(r.d.max, 30);
  assert.match(r.d.error, /Keep it under 30 seconds/);
  await pepeSays();                     // (review fix 1: over 30 s only while Pepe follows the job's limits)
  await setLimits({ gap_s: 0, burst: 30, max_secs: 60 });
  assert.equal((await upload(45)).status, 200);
  assert.equal((await upload(61)).status, 200);
  r = await upload(62);
  assert.equal(r.status, 400);
  assert.match(r.d.error, /Keep it under 60 seconds/);
  await setLimits({ gap_s: 0, burst: 30, max_secs: 10 });
  r = await upload(12);
  assert.equal(r.status, 400);
  assert.match(r.d.error, /Keep it under 10 seconds/);
  await setLimits({ reset: true });
});

// The byte cap after nginx's 2026-11-08 change: POST /api/rooms/<slug>/clip takes up to 4 MB (client_max_body_size 4m on that
// location only; every other request stays at 1 MB - botupload.js). Review fix 2's 960 KB ceiling (under the old 1 MB) cut a
// Safari clip off past ~47 s; now the cap is (max + 1 s) x 24 KB/s (192 kbit/s = 6x the recorder's 32 kbit/s, room for Safari's
// AAC), never below 600 KB, never above 3.5 MB - under nginx's 4 MB, and under PEPE's own cap for the same max length at every
// length (pepe_relay.clip_max_bytes in pttlimits-bot: 1.5 MB up to ~47 s, 32 kB/s above, a 4 MB ceiling - 3.84 MB at 120 s), so
// he never refuses a clip the site took as "the recording is empty or too big".
const NGINX_CLIP_MAX = 4 * 1024 * 1024;
const pepeMaxBytes = (s) => Math.min(4000000, Math.max(1500000, Math.floor(s * 32000)));   // pepe_relay.clip_max_bytes
test("the byte cap: (max + 1 s) x 24 KB/s, 600 KB floor, 3.5 MB ceiling - under nginx's 4 MB clip upload and under Pepe's own cap at every max length", async () => {
  assert.equal(PT.BYTES_PER_SEC, 24 * 1024, "24 KB a second");
  assert.equal(PT.BYTES_FLOOR, 600 * 1024, "never below today's 600 KB");
  assert.equal(PT.BYTES_CEIL, Math.round(3.5 * 1024 * 1024), "a 3.5 MB ceiling");
  assert.ok(PT.BYTES_CEIL <= NGINX_CLIP_MAX - 256 * 1024, "the ceiling stays well under nginx's 4 MB on the clip upload: " + PT.BYTES_CEIL);
  const [lo, hi] = PT.LIMITS.max_secs;
  for (let s = lo; s <= hi; s++) {
    const b = PT.maxBytes(s);
    assert.equal(b, Math.min(PT.BYTES_CEIL, Math.max(600 * 1024, (s + 1) * 24 * 1024)), s + " s: (max + 1 s) x 24 KB/s inside floor / ceiling");
    // the recorder asks for 32 kbit/s Opus = 4 KB a second; a browser that ignores it (AAC on Safari) can be far above that
    assert.ok(b >= (s + 1) * 4000 * 6, s + " s: at least 6x the recorder's bitrate");
    assert.ok(b <= pepeMaxBytes(s), `${s} s: under Pepe's own cap for the same length (${b} <= ${pepeMaxBytes(s)})`);
    assert.ok(b <= NGINX_CLIP_MAX, s + " s: under nginx's 4 MB");
  }
  assert.equal(PT.maxBytes(30), 31 * 24 * 1024, "30 s: 744 KB (Pepe's 1.5 MB)");
  assert.equal(PT.maxBytes(120), 121 * 24 * 1024, "120 s: about 2.8 MB (Pepe's 3.84 MB)");
  assert.equal(PT.maxBytes(100000), PT.BYTES_CEIL, "a huge value stops at the ceiling");
  reset();
  await pepeSays();                     // (review fix 1: a 120 s max only while Pepe follows the job's limits)
  await setLimits({ gap_s: 0, burst: 30, max_secs: 30 });
  let r = await upload(29, Buffer.alloc(PT.maxBytes(30) + 1024, 1));
  assert.equal(r.status, 413, "over the cap for 30 s");
  assert.equal(r.d && r.d.code, "too_big", "a JSON answer the page can show (not an HTML error page)");
  assert.equal(r.d.ok, false);
  await setLimits({ gap_s: 0, burst: 30, max_secs: 120 });
  r = await upload(110, Buffer.alloc(PT.maxBytes(30) + 1024, 1));
  assert.equal(r.status, 200, "the same clip fits once the max length is 120 s: " + JSON.stringify(r.d));
  r = await upload(110, Buffer.alloc(1024 * 1024 + 64 * 1024, 1));
  assert.equal(r.status, 200, "past the old 1 MB (nginx takes 4 MB on the clip upload now): " + JSON.stringify(r.d));
  r = await upload(119, Buffer.alloc(PT.maxBytes(120) - 1024, 1));
  assert.equal(r.status, 200, "just under the 120 s cap: " + JSON.stringify(r.d));
  r = await upload(119, Buffer.alloc(PT.maxBytes(120) + 1024, 1));
  assert.equal(r.status, 413, "never past the 120 s cap");
  assert.equal(r.d && r.d.code, "too_big");
  await setLimits({ reset: true });
});

test("the body is checked again against the length its job carries - a max length lowered during the upload can't send Pepe a clip over his cap for it", async () => {
  reset();
  await pepeSays();
  await setLimits({ gap_s: 0, burst: 30, max_secs: 120 });
  // the body parser read the cap for 120 s; by the time the upload is checked and counted the setting says 30 s (an admin saved
  // in between) - the job would carry max_secs 30, and Pepe would refuse (and the member lose) a body over his 30 s cap
  const real = PT.effective;
  PT.effective = (...a) => Object.assign(real(...a), { max_secs: 30 });
  try {
    let r;
    try { r = await upload(20, Buffer.alloc(PT.maxBytes(30) + 1024, 1)); } finally { PT.effective = real; }
    assert.equal(r.status, 413, JSON.stringify(r.d));
    assert.equal(r.d && r.d.code, "too_big");
    assert.equal(relay._jobs.size, 0, "no clip job");
    assert.equal((relay._hits.get("clip|p1") || []).length, 0, "nothing counted on the play limit");
    assert.equal((relay._hits.get("clipup|p1") || []).length, 0, "nor on the flood guard");
    r = await upload(20, Buffer.alloc(PT.maxBytes(30) + 1024, 1));
    assert.equal(r.status, 200, "the setting really is 120 s: the same body goes through");
  } finally { reset(); await setLimits({ reset: true }); }
});

test("every clip job tells Pepe its limits: max_secs, gap_s, burst, window_s - the values it was accepted under", async () => {
  reset();
  await pepeSays();                     // (review fix 1: a 90 s max only while Pepe follows the job's limits)
  const a = await upload();
  assert.equal(a.status, 200);
  await setLimits({ gap_s: 0, burst: 7, max_secs: 90 });
  const b = await upload(80);
  assert.equal(b.status, 200, JSON.stringify(b.d));
  const offered = relay.takeJobs(new Set([R.id]));
  const ja = offered.find((j) => j.id === a.d.id), jb = offered.find((j) => j.id === b.d.id);
  assert.ok(ja && jb);
  assert.equal(ja.kind, "clip");
  assert.deepEqual({ max_secs: ja.max_secs, gap_s: ja.gap_s, burst: ja.burst, window_s: ja.window_s }, { max_secs: 30, gap_s: 30, burst: 3, window_s: 600 });
  assert.deepEqual({ max_secs: jb.max_secs, gap_s: jb.gap_s, burst: jb.burst, window_s: jb.window_s }, { max_secs: 90, gap_s: 0, burst: 7, window_s: 600 });
  for (const k of ["max_secs", "gap_s", "burst", "window_s"]) assert.equal(typeof jb[k], "number", k);
  // other jobs don't carry them
  const say = relay.newJob({ kind: "say", roomId: R.id, userId: "p1", username: "p1_patv", camfrog: "alice", text: "hi" });
  const s = relay.takeJobs(new Set([R.id])).find((j) => j.id === say.id);
  assert.ok(s && !("max_secs" in s) && !("gap_s" in s));
  await setLimits({ reset: true });
});

// ── the page: the live view gives the max length; the recorder stops there and says so ──

test("the live view carries the max length (room.pttMax) - changed at once", async () => {
  const bridge = require(path.join(repo, "bridge"));
  const room = { id: "PttLim.Live", name: "PttLim.Live" };
  await bridge.ingest({ events: [], rooms: [{ room, topic: "", count: 2, relay: true, mic_relay: true,
    members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, { id: "alice", login: "alice", display: "Alice" }], mic: [] }] });
  const LR = bridge.bySlug(bridge.slugify(room.name));
  assert.ok(LR, "the room is known");
  let v = await bridge.liveView(LR, 0, null, null, null, true, { viewer: { userId: "test-viewer" } });
  assert.equal(v.room.micRelay, true);
  assert.equal(v.room.pttMax, 30);
  await pepeSays();                     // (review fix 1: a 75 s max only while Pepe follows the job's limits)
  await setLimits({ gap_s: 30, burst: 3, max_secs: 75 });
  v = await bridge.liveView(LR, 0, null, null, null, true, { viewer: { userId: "test-viewer" } });
  assert.equal(v.room.pttMax, 75);
  await setLimits({ reset: true });
});

// a stub DOM for public/js/room-bridge.js (as test/relayclip.test.js)
class Cls {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return on; }
}
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.classList = new Cls(); this.textContent = ""; this.options = []; }
  set className(v) { this.classList = new Cls(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get className() { return [...this.classList.s].join(" "); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  fire(t, e) { (this.listeners[t] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, e || {}))); }
}
function loadClient(opts = {}) {
  const timers = [], fns = [], fetches = [];
  // review fixes 2 + 3: a clock the test moves (how long a clip ran) and the upload's answer (opts.res)
  const clock = { t: 1000000 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const win = {
    MediaRecorder: class { constructor(s) { this.stream = s; this.state = "inactive"; this.mimeType = "audio/webm"; }
      static isTypeSupported(t) { return t === "audio/webm"; }
      start() { this.state = "recording"; } stop() { this.state = "inactive"; if (this.onstop) this.onstop(); } },
    addEventListener() {}, removeEventListener() {},
  };
  const track = { stop() {} };
  const doc = { createElement: (t) => new El(t), hidden: false, addEventListener() {}, removeEventListener() {} };
  doc.defaultView = win;
  const ctx = {
    window: win, console,
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0,
      mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [track] }) } },
    document: doc,
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn, ms) => { timers.push(ms); fns.push({ fn, ms }); return fns.length; },
    clearTimeout: (id) => { if (fns[id - 1]) fns[id - 1].cleared = true; },
    setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    fetch: (url, o) => { fetches.push({ url, o }); return Promise.resolve(opts.res || { status: 200, ok: true, json: () => Promise.resolve({ ok: true, id: "j1" }) }); },
    Blob: class { constructor(p, o) { this.type = o.type; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    Date: FakeDate, JSON, Math, Number, String, Object, Array, Promise, isFinite, Uint8Array,
  };
  ctx.window.MediaRecorder = win.MediaRecorder;
  ctx.MediaRecorder = win.MediaRecorder;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8"), ctx);
  return { PATV: ctx.window.PATVRoom, timers, fns, fetches, clock };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
async function record(update, opts) {
  const { PATV, timers, fns, fetches, clock } = loadClient(opts);
  const host = new El("div");
  host.ownerDocument = null;
  const p = PATV.ptt(host, "room-pttlim");
  if (update) p.update(update);
  const box = host.children[0], btn = box.children[0], txt = box.children[2];
  const idleText = txt.textContent;
  btn.fire("keydown", { key: "Enter" });
  await new Promise((r) => setImmediate(r));
  // the recorder's own auto-stop (the last timer it set while starting)
  const auto = fns.filter((f) => f.ms >= 1000).pop() || null;
  return { p, idleText, btn, txt, timers, fns, fetches, clock, auto };
}

test("the recorder stops at the server's max length (0.5 s early - review fix 3) and says the real number", async () => {
  let r = await record({ room: { micRelay: true, pttMax: 45 }, mine: [] });
  assert.equal(r.idleText, "up to 45 s · Pepe plays it on the mic when it's free");
  assert.equal(r.btn.getAttribute("aria-pressed"), "true", "recording");
  assert.ok(r.timers.includes(44500), "auto-stop 0.5 s before 45 s: " + JSON.stringify(r.timers));
  assert.ok(!r.timers.includes(20000), "not the old 20 s");
  r = await record({ room: { micRelay: true, pttMax: 120 }, mine: [] });
  assert.equal(r.idleText, "up to 120 s · Pepe plays it on the mic when it's free");
  assert.ok(r.timers.includes(119500));
  // no number from the server (an older one) / a silly one: the default, 30 s
  r = await record({ room: { micRelay: true }, mine: [] });
  assert.equal(r.idleText, "up to 30 s · Pepe plays it on the mic when it's free");
  assert.ok(r.timers.includes(29500));
  r = await record({ room: { micRelay: true, pttMax: 99999 }, mine: [] });
  assert.ok(r.timers.includes(29500), "out of range: the default");
});

// ── review fixes ──

test("review fix 1: over Pepe's own 30 s only while he says he follows the job's limits (ptt_limits: 1 on his pull, last 2 min)", async () => {
  PT._reset();
  await PT.init();
  reset();
  await setLimits({ gap_s: 0, burst: 30, max_secs: 60 });
  assert.equal(PT.current().max_secs, 60, "the setting is saved as asked");
  // no word from Pepe since the site started: an older Pepe refuses AND charges (bad_clip) anything over his 30 s - the site keeps 30
  assert.equal(PT.pepeFollows(), false);
  assert.equal(PT.effective().max_secs, 30);
  let r = await upload(45);
  assert.equal(r.status, 400, "a 45 s clip would cost the member a clip that never plays");
  assert.equal(r.d.code, "too_long");
  assert.equal(r.d.max, 30);
  assert.match(r.d.error, /Keep it under 30 seconds/);
  const short = await upload(25);
  assert.equal(short.status, 200);
  const job = relay.takeJobs(new Set([R.id])).find((j) => j.id === short.d.id);
  assert.equal(job.max_secs, 30, "the job says the length the site enforced");
  // an older Pepe's pull (no flag) changes nothing
  await pepeSays(null);
  assert.equal(PT.pepeFollows(), false);
  assert.equal((await upload(45)).status, 400);
  // a Pepe that reads the job's limits says so on his long-poll: the setting applies in full
  await pepeSays();
  assert.equal(PT.pepeFollows(), true);
  assert.equal(PT.effective().max_secs, 60);
  r = await upload(45);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const j2 = relay.takeJobs(new Set([R.id])).find((j) => j.id === r.d.id);
  assert.equal(j2.max_secs, 60);
  // he went quiet (a rollback to an older build, Pepe down) for longer than PEPE_TTL: back to 30
  assert.ok(PT.PEPE_TTL >= 30 * 1000 && PT.PEPE_TTL <= 5 * 60 * 1000, "a few of his 10 s long-polls: " + PT.PEPE_TTL);
  PT.notePepe({ ptt_limits: 1 }, Date.now() - PT.PEPE_TTL - 1000);
  assert.equal(PT.pepeFollows(), false);
  assert.equal(PT.effective().max_secs, 30);
  assert.equal((await upload(45)).status, 400);
  // a stricter setting applies at once, Pepe or not (his own 30 s is the most he ever takes)
  await setLimits({ gap_s: 0, burst: 30, max_secs: 10 });
  assert.equal(PT.effective().max_secs, 10);
  assert.equal((await upload(12)).status, 400);
  // the card says whether he follows them
  let v = await PT.view();
  assert.equal(v.pepe.follows, false);
  assert.deepEqual(v.pepe.old, { gap_s: 30, burst: 3, max_secs: 30 });
  await pepeSays();
  v = await PT.view();
  assert.equal(v.pepe.follows, true);
  assert.ok(v.pepe.at > 0);
  await setLimits({ reset: true });
});

test("review fix 1: the bridge sync counts too (a Pepe that syncs without the long-poll) - bridge.js hands its body to pttlimits", () => {
  const src = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  const sa = src.slice(src.indexOf("async function syncAnswer("), src.indexOf("async function syncAnswer(") + 4000);
  assert.match(sa, /require\("\.\/pttlimits"\)\.notePepe\(body\)/, "syncAnswer notes Pepe's ptt_limits flag");
  assert.match(src, /pttMax: require\("\.\/pttlimits"\)\.effective\(\)\.max_secs/, "the live view's pttMax is the length in force");
  // a sync body's flag
  PT._reset();
  PT.notePepe({ ptt_limits: true });
  assert.equal(PT.pepeFollows(), true);
  PT._reset();
  for (const bad of [null, {}, { ptt_limits: 0 }, { ptt_limits: "1" }, { ptt_limits: 2 }]) {
    PT.notePepe(bad);
    assert.equal(PT.pepeFollows(), false, JSON.stringify(bad));
  }
});

test("review fix 2: the page words any 413 (nginx's HTML one too) as 'too big', never 'couldn't reach the site'", async () => {
  for (const res of [
    { status: 413, ok: false, json: () => Promise.reject(new SyntaxError("Unexpected token <")) },   // nginx's own page
    { status: 413, ok: false, json: () => Promise.resolve({ ok: false, code: "too_big", error: "That recording is too big - try a shorter one." }) },
  ]) {
    const r = await record({ room: { micRelay: true, pttMax: 30 }, mine: [] }, { res });
    r.clock.t += 10000;
    r.btn.fire("keydown", { key: "Enter" });          // tap again: send
    await flush();
    assert.equal(r.fetches.length, 1, "uploaded");
    assert.equal(r.txt.textContent, "that recording is too big — try a shorter one");
  }
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["js.pad.ptt.too_big"], "that recording is too big — try a shorter one");
});

test("review fix 3: a clip that ran over max + 0.5 s (a late timer) is never sent - Pepe would refuse it and charge it", async () => {
  // the auto-stop lands on time: sent, with its real length
  let r = await record({ room: { micRelay: true, pttMax: 30 }, mine: [] });
  assert.equal(r.auto && r.auto.ms, 29500);
  r.clock.t += 29600;
  r.auto.fn();
  await flush();
  assert.equal(r.fetches.length, 1, "sent");
  assert.equal(r.fetches[0].o.headers["x-clip-secs"], "29.6");
  // a busy page: the timer fired 0.9 s late (30.4 s in all) - still inside Pepe's +0.5 s, sent
  r = await record({ room: { micRelay: true, pttMax: 30 }, mine: [] });
  r.clock.t += 30400;
  r.auto.fn();
  await flush();
  assert.equal(r.fetches.length, 1);
  // 1.5 s late (31 s): Pepe decodes more than 30.5 s and charges it as bad_clip - kept here, said why
  r = await record({ room: { micRelay: true, pttMax: 30 }, mine: [] });
  r.clock.t += 31000;
  r.auto.fn();
  await flush();
  assert.equal(r.fetches.length, 0, "not sent");
  assert.equal(r.txt.textContent, "too long — keep it under 30 s");
  // the length the recording STARTED with counts (a change of the setting meanwhile doesn't move it)
  r = await record({ room: { micRelay: true, pttMax: 60 }, mine: [] });
  assert.equal(r.auto.ms, 59500);
  r.p.update({ room: { micRelay: true, pttMax: 30 }, mine: [] });
  r.clock.t += 45000;
  r.auto.fn();
  await flush();
  assert.equal(r.fetches.length, 1, "45 s of a 60 s max: sent");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["js.pad.ptt.too_long"], "too long — keep it under {n} s");
});

test("review fix 4: a clip Pepe said is playing gets its own length + 90 s to say how it went (never failed mid-play)", async () => {
  reset();
  await pepeSays();
  await setLimits({ gap_s: 0, burst: 30, max_secs: 120 });
  const up = await upload(110);
  assert.equal(up.status, 200, JSON.stringify(up.d));
  relay.takeJobs(new Set([R.id]));                    // Pepe took it
  relay.applyAcks([{ id: up.d.id, state: "playing", ok: true, msg: "playing on the mic now" }]);
  const j = relay._jobs.get(up.d.id);
  assert.equal(j.state, "playing");
  // a busy room: it started 6.5 min after Pepe took it, and is 130 s in (a 110-120 s clip + the mic drop + his ack)
  const now = Date.now();
  j.playingAt = now - 130 * 1000;
  j.claimed = j.playingAt - 6.5 * 60 * 1000;
  relay._sweep(now);
  assert.equal(j.state, "playing", "still open - his 'played' is on its way");
  assert.ok(!j.limBack, "its limit not given back");
  relay._sweep(j.playingAt + 211 * 1000);             // past 120 s + 90 s: Pepe never said
  assert.equal(j.state, "done");
  assert.equal(j.result.code, "unconfirmed");
  // a 30 s clip keeps the 2 minutes it had
  await setLimits({ reset: true });
  reset();
  const up2 = await upload(20);
  relay.takeJobs(new Set([R.id]));
  relay.applyAcks([{ id: up2.d.id, state: "playing", ok: true, msg: "playing" }]);
  const j2 = relay._jobs.get(up2.d.id);
  j2.playingAt = Date.now();
  j2.claimed = j2.playingAt - 7.9 * 60 * 1000;
  relay._sweep(j2.playingAt + 119 * 1000);
  assert.equal(j2.state, "playing");
  relay._sweep(j2.playingAt + 121 * 1000);
  assert.equal(j2.state, "done");
  // a job from before the setting (no limits on it): the 2 minutes
  const old = relay.newJob({ kind: "clip", roomId: R.id, userId: "p1", username: "p1_patv", camfrog: "alice", data: Buffer.alloc(600), mime: "audio/webm", secs: 5 });
  old.state = "playing"; old.playingAt = Date.now(); old.claimed = old.playingAt - 7.9 * 60 * 1000;
  relay._sweep(old.playingAt + 121 * 1000);
  assert.equal(old.state, "done");
});

test("the wording: one string with {n} (js.pad.ptt.upto_n), the old fixed '20 s' string gone from every catalog", () => {
  const dir = path.join(repo, "locales");
  const en = JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8"));
  assert.equal(en["js.pad.ptt.upto_n"], "up to {n} s · Pepe plays it on the mic when it's free");
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-zA-Z-]+\.json$/.test(x) && x !== "glossary.json")) {
    const cat = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.ok(!("js.pad.ptt.upto" in cat), f + ": the old 'up to 20 s' string is gone");
  }
  const src = fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8");
  assert.doesNotMatch(src, /setTimeout\(stop, 20000\)/, "no fixed 20 s stop");
  assert.doesNotMatch(src, /'js\.pad\.ptt\.upto'/);
  for (const v of ["room.ejs", "home.ejs"]) {
    assert.match(fs.readFileSync(path.join(repo, "views", v), "utf8"), /room-bridge\.js\?v=32/, v + " loads the new recorder");   // v32 (v31 = the story camera 1.99alu)
  }
});
