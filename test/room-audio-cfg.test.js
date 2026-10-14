// Offline tests for 1.99yd: room-audio settings (roomaudiocfg.js, /admin/pepe/audio):
//   * defaults = what shipped (bot 1.99ya/yb, site 1.99ya); strict validation (ranges, choices, min <= max, splice >= prebuffer + 100)
//   * the admin API: Admins only, same-site fetch, a save -> v + 1 and one admin_audit row (from -> to), reset to defaults,
//     a bad value changes nothing; the page renders
//   * Pepe: /api/bridge/audio answers carry audio_cfg only when his acfg_v is older; his state push is stored (cleaned) and
//     answered with newer settings; !audiostats latency writes through (/api/pepe/audio/set, bot token, audited as Pepe)
//   * the ⚡ ticket serves the jitter target
//   NODE_PATH=G:/PATV/node_modules node --test test/room-audio-cfg.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "room-audio-cfg-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.WHIP_AUTH_PEER;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const RR = require(path.join(repo, "roomrtc"));
const PA = require(path.join(repo, "padaccess"));
const bridge = require(path.join(repo, "bridge"));
const AC = require(path.join(repo, "roomaudiocfg"));

const ALPHA = "Alpha.Room";
let base, server;
const req = (method, p, body, user, headers) => fetch(base + p, { method, headers: Object.assign({ "content-type": "application/json" },
  user ? { "x-test-user": user } : {}, headers || {}), body: body == null ? undefined : JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }));
const post = (p, body, user, headers) => req("POST", p, body, user, headers);
const adminPost = (body, user = "adm") => post("/api/admin/pepe/audio", body, user, { "X-Requested-With": "fetch" });
const bot = (p, body) => post(p, Object.assign({ password: "bot-token" }, body)).then((r) => r.d);
const room = (id, name) => ({ room: { id, name }, topic: "", members: [{ login: "bob", display: "Bob" }], count: 2, audio: true, audio_on: true });
const audits = () => getQuery("SELECT * FROM admin_audit WHERE action = 'room_audio_cfg' ORDER BY id");

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, cls] of [["u1", "pleb"], ["adm", "Admin"]]) {
    await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", [id, id, id, cls]);
  }
  await S.init();
  await PA.init();
  await AC.init();
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((q, r, next) => { const u = q.get("x-test-user"); q.user = u ? { userId: u, username: u, class: u === "adm" ? "Admin" : "pleb" } : null; next(); });
  const deps = { isBotToken: (t) => t === "bot-token", addUser: (q, r, next) => next() };
  bridge.register(app, deps);
  AC.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await bot("/api/bridge/sync", { events: [], rooms: [room(ALPHA, "Alpha")] });
  await S.setConfig({ webrtc_enabled: true, room_rtc: "all", room_rtc_cap: 25 }, "test");
});
test.after(() => { server.close(); });

test("defaults = what shipped; strict validation names each bad field; lenient clamps", () => {
  assert.deepEqual(AC.DEFAULTS, { pacing: "helper", helper_mode: "adaptive", helper_fixed_ms: 1000, helper_min_ms: 200, helper_max_ms: 1000,
    helper_headroom_ms: 120, helper_window_s: 60, inproc_prebuffer_ms: 140, inproc_splice_ms: 600, mixer_latency_s: 0.7, jitter_ms: 200,
    opus_kbps: 64, mp3_kbps: 64 });
  assert.deepEqual(AC.normalize({}).errors, {});
  const bad = AC.normalize({ pacing: "warp", helper_min_ms: 50, mixer_latency_s: 3.5, jitter_ms: "lots", mp3_kbps: 70, opus_kbps: "64.0x" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["helper_min_ms", "jitter_ms", "mixer_latency_s", "mp3_kbps", "opus_kbps", "pacing"]);
  assert.match(bad.errors.mixer_latency_s, /0\.2.3/);
  assert.equal(AC.normalize({ helper_min_ms: 900, helper_max_ms: 300 }).errors.helper_min_ms, "can't be more than the adaptive max");
  assert.ok(AC.normalize({ inproc_prebuffer_ms: 600, inproc_splice_ms: 650 }).errors.inproc_splice_ms);
  assert.deepEqual(AC.normalize({ inproc_prebuffer_ms: 600, inproc_splice_ms: 700 }).errors, {});
  const len = AC.normalize({ helper_min_ms: 900, helper_max_ms: 300, mixer_latency_s: 9, pacing: "x" }, { lenient: true });
  assert.deepEqual(len.errors, {});
  assert.equal(len.cfg.helper_min_ms, 300); assert.equal(len.cfg.helper_max_ms, 900);
  assert.equal(len.cfg.mixer_latency_s, 3); assert.equal(len.cfg.pacing, "helper");
  assert.equal(AC.normalize({ mixer_latency_s: "1.234" }).cfg.mixer_latency_s, 1.23, "string numbers from the form");
  assert.equal(AC.normalize({ helper_fixed_ms: "" }, { base: { ...AC.DEFAULTS, helper_fixed_ms: 800 } }).cfg.helper_fixed_ms, 800, "blank = keep");
});

test("admin API: Admins only, fetch only; save -> v+1 + audit; a bad value changes nothing; reset", async () => {
  assert.equal((await adminPost({ cfg: { pacing: "inprocess" } }, "u1")).status, 403);
  assert.equal((await post("/api/admin/pepe/audio", { cfg: { pacing: "inprocess" } }, "adm")).status, 403, "no X-Requested-With");
  assert.equal((await adminPost({ cfg: { pacing: "inprocess" } }, "adm", )).status, 200);
  let v = AC.current();
  assert.equal(v.v, 1); assert.equal(v.cfg.pacing, "inprocess");
  let r = await adminPost({ cfg: { helper_mode: "fixed", helper_fixed_ms: 1000, mixer_latency_s: "1.0" }, reason: "trying 1 s" });
  assert.equal(r.d.v, 2);
  assert.deepEqual(r.d.changed, { helper_mode: ["adaptive", "fixed"], mixer_latency_s: [0.7, 1] });
  assert.equal(AC.current().cfg.pacing, "inprocess", "a partial save keeps the rest");
  r = await adminPost({ cfg: { jitter_ms: 5000, opus_kbps: 64 } });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.d.fields), ["jitter_ms"]);
  assert.equal(AC.current().v, 2, "nothing changed");
  r = await adminPost({ cfg: { jitter_ms: 200 } });
  assert.equal(r.d.same, true, "no change: no new version");
  const a = await audits();
  assert.equal(a.length, 2);
  const d = JSON.parse(a[1].detail);
  assert.equal(a[1].admin_id, "adm"); assert.equal(a[1].reason, "trying 1 s"); assert.equal(d.v, 2); assert.equal(d.to.helper_fixed_ms, 1000);
  r = await adminPost({ reset: true });
  assert.equal(r.d.v, 3);
  assert.deepEqual(AC.current().cfg, AC.DEFAULTS);
  assert.equal(JSON.parse((await audits())[2].detail).action, "reset");
  const g = await req("GET", "/api/admin/pepe/audio", null, "adm");
  assert.equal(g.d.v, 3); assert.equal(g.d.audit.length, 3);
  const page = await fetch(base + "/admin/pepe/audio", { headers: { "x-test-user": "adm" } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="room-audio"/); assert.match(html, /Reset to defaults/);
  assert.equal((await fetch(base + "/admin/pepe/audio", { headers: { "x-test-user": "u1" } })).status, 403);
});

test("Pepe: settings ride on the audio answer when his version is older; the state push is stored and answered", async () => {
  await adminPost({ cfg: { pacing: "inprocess", jitter_ms: 350 } });
  const v = AC.current().v;
  let r = await bot("/api/bridge/audio", { room: ALPHA, seq: 1, data: "", rtc_cap: true });
  assert.equal(r.audio_cfg.v, v, "no acfg_v (an older Pepe / a fresh start): he gets them");
  assert.equal(r.audio_cfg.cfg.pacing, "inprocess");
  r = await bot("/api/bridge/audio", { room: ALPHA, seq: 2, data: "", rtc_cap: true, acfg_v: v - 1 });
  assert.equal(r.audio_cfg.v, v, "older: he gets them");
  r = await bot("/api/bridge/audio", { room: ALPHA, seq: 3, data: "", rtc_cap: true, acfg_v: v });
  assert.equal(r.audio_cfg, undefined, "current: nothing extra");
  r = await bot("/api/bridge/audio", { room: "Nope.Room", seq: 1, data: "", acfg_v: null });
  assert.equal(r.audio_cfg.v, v, "even for a room the site doesn't stream");
  // the ⚡ ticket carries the jitter target
  const t = await post("/api/rooms/alpha/audio/rtc", {}, "u1");
  assert.equal(t.d.ok, true); assert.equal(t.d.jitter_ms, 350);
  // state push
  assert.equal((await post("/api/pepe/audio/state", { password: "nope", state: {} })).status, 403);
  const line = "[AUDIO-STATS] Alpha.Room 60s: mix pkts 1500 | rtc underruns 0";
  r = await bot("/api/pepe/audio/state", { state: { v: v - 1, src: "site", cfg: { pacing: "helper", mixer_latency_s: 99 }, net_audio: true,
    rooms: { [ALPHA]: { streaming: true, mp3_listeners: 1, mixer_latency_s: 0.7, stats: line + "\u0000<b>", stats_at: 1700000000,
                        rtc: { state: "live", pacing: "helper", buffer_ms: 640, target_ms: 700, restarts: 0, evil: "x" } } } } });
  assert.equal(r.ok, true); assert.equal(r.audio_cfg.v, v, "his v is older: the answer brings the current one");
  r = await bot("/api/pepe/audio/state", { state: { v, src: "site", cfg: {}, rooms: {} } });
  assert.equal(r.audio_cfg, undefined);
  r = await bot("/api/pepe/audio/state", { state: { v, src: "saved", cfg: {}, rooms: {} } });
  assert.equal(r.audio_cfg.v, v, "a saved copy isn't the site's: answered with it");
  await bot("/api/pepe/audio/state", { state: { v: v - 1, src: "site", cfg: { mixer_latency_s: 99 },
    rooms: { [ALPHA]: { streaming: true, stats: line, stats_at: 1700000000, rtc: { state: "live", pacing: "helper", buffer_ms: 640, target_ms: 700, evil: 1 } } } } });
  const view = (await req("GET", "/api/admin/pepe/audio", null, "adm")).d;
  assert.equal(view.online, true);
  assert.equal(view.bot.cfg.mixer_latency_s, 3, "his values cleaned (clamped)");
  const row = view.bot.rooms[ALPHA];
  assert.equal(row.stats, line); assert.equal(row.stats_at, 1700000000000);
  assert.equal(row.rtc.buffer_ms, 640); assert.equal(row.rtc.evil, undefined, "only known fields kept");
});

test("!audiostats latency writes through: bot token, validated, audited as Pepe; the next answer carries it", async () => {
  const v0 = AC.current().v;
  assert.equal((await post("/api/pepe/audio/set", { password: "nope", key: "mixer_latency_s", value: 1 })).status, 403);
  assert.equal((await post("/api/pepe/audio/set", { password: "bot-token", key: "mixer_latency_s", value: 7 })).status, 400);
  assert.equal((await post("/api/pepe/audio/set", { password: "bot-token", key: "pacing", value: "helper" })).status, 400);
  const r = await bot("/api/pepe/audio/set", { key: "mixer_latency_s", value: 1.25, by: "admin<x>" });
  assert.equal(r.ok, true); assert.equal(r.audio_cfg.v, v0 + 1); assert.equal(r.audio_cfg.cfg.mixer_latency_s, 1.25);
  assert.equal(r.audio_cfg.cfg.pacing, "inprocess", "only the latency changed");
  const a = (await audits()).pop();
  assert.equal(a.admin_id, "pepe"); assert.equal(a.admin_name, "Pepe (!audiostats, adminx)");
  assert.equal(JSON.parse(a.detail).action, "chat");
  const b = await bot("/api/bridge/audio", { room: ALPHA, seq: 9, data: "", acfg_v: v0 });
  assert.equal(b.audio_cfg.cfg.mixer_latency_s, 1.25);
});
