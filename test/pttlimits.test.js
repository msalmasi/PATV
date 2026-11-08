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

test("the byte cap grows with the max length (room for 4x the recorder's 32 kbit/s), with a hard ceiling", async () => {
  // the recorder asks for 32 kbit/s Opus = 4 KB a second; a browser that ignores it (AAC on Safari) can be far above that
  for (const s of [3, 30, 60, 120]) {
    assert.ok(PT.maxBytes(s) >= (s + 1) * 4000 * 4, s + " s: at least 4x the recorder's bitrate");
    assert.ok(PT.maxBytes(s) >= 600 * 1024, s + " s: never below today's 600 KB");
    assert.ok(PT.maxBytes(s) <= PT.BYTES_CEIL, s + " s: under the ceiling");
  }
  assert.ok(PT.maxBytes(120) > PT.maxBytes(30));
  assert.equal(PT.maxBytes(100000), PT.BYTES_CEIL, "a huge value stops at the ceiling");
  assert.ok(PT.BYTES_CEIL <= 3 * 1024 * 1024, "the ceiling stays small");
  reset();
  await setLimits({ gap_s: 0, burst: 30, max_secs: 30 });
  let r = await upload(29, Buffer.alloc(PT.maxBytes(30) + 1024, 1));
  assert.equal(r.status, 413, "over the cap for 30 s");
  assert.equal(r.d && r.d.code, "too_big", "a JSON answer the page can show (not an HTML error page)");
  assert.equal(r.d.ok, false);
  await setLimits({ gap_s: 0, burst: 30, max_secs: 120 });
  r = await upload(110, Buffer.alloc(PT.maxBytes(30) + 1024, 1));
  assert.equal(r.status, 200, "the same clip fits once the max length is 120 s: " + JSON.stringify(r.d));
  r = await upload(110, Buffer.alloc(PT.BYTES_CEIL + 1024, 1));
  assert.equal(r.status, 413, "never past the ceiling");
  await setLimits({ reset: true });
});

test("every clip job tells Pepe its limits: max_secs, gap_s, burst, window_s - the values it was accepted under", async () => {
  reset();
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
function loadClient() {
  const timers = [];
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
    setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {},
    setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    fetch: () => Promise.resolve({ json: () => ({ ok: true }) }), Blob: class { constructor(p, o) { this.type = o.type; } },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    Date, JSON, Math, Number, String, Object, Array, Promise, isFinite, Uint8Array,
  };
  ctx.window.MediaRecorder = win.MediaRecorder;
  ctx.MediaRecorder = win.MediaRecorder;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8"), ctx);
  return { PATV: ctx.window.PATVRoom, timers };
}
async function record(update) {
  const { PATV, timers } = loadClient();
  const host = new El("div");
  host.ownerDocument = null;
  const p = PATV.ptt(host, "room-pttlim");
  if (update) p.update(update);
  const box = host.children[0], btn = box.children[0], txt = box.children[2];
  const idleText = txt.textContent;
  btn.fire("keydown", { key: "Enter" });
  await new Promise((r) => setImmediate(r));
  return { idleText, btn, timers };
}

test("the recorder stops at the server's max length and says the real number", async () => {
  let r = await record({ room: { micRelay: true, pttMax: 45 }, mine: [] });
  assert.equal(r.idleText, "up to 45 s · Pepe plays it on the mic when it's free");
  assert.equal(r.btn.getAttribute("aria-pressed"), "true", "recording");
  assert.ok(r.timers.includes(45000), "auto-stop at 45 s: " + JSON.stringify(r.timers));
  assert.ok(!r.timers.includes(20000), "not the old 20 s");
  r = await record({ room: { micRelay: true, pttMax: 120 }, mine: [] });
  assert.equal(r.idleText, "up to 120 s · Pepe plays it on the mic when it's free");
  assert.ok(r.timers.includes(120000));
  // no number from the server (an older one) / a silly one: the default, 30 s
  r = await record({ room: { micRelay: true }, mine: [] });
  assert.equal(r.idleText, "up to 30 s · Pepe plays it on the mic when it's free");
  assert.ok(r.timers.includes(30000));
  r = await record({ room: { micRelay: true, pttMax: 99999 }, mine: [] });
  assert.ok(r.timers.includes(30000), "out of range: the default");
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
    assert.match(fs.readFileSync(path.join(repo, "views", v), "utf8"), /room-bridge\.js\?v=31/, v + " loads the new recorder");
  }
});
