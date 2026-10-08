// Offline tests for 1.99fd - Pepe's main stream over WHIP (webrtc.js / bridge.js / stage-room.js) and the HLS
// live-latency controller (stage-player.js liveStep):
//   * the auth hook for Pepe's path: his bearer (HMAC of SECRET_KEY, per site) publishes - flag on or off -, a wrong /
//     missing one doesn't, nothing but WHIP publishes; the relay's loopback RTSP read always, from outside never;
//     viewers' WHEP / HLS reads only with the flag; the other site's Pepe path goes to the peer; rotation / "off"
//   * the bot route hands out URL + bearer only for the bot token
//   * the sync notes Pepe's path (pepeWhep) but never beats or kicks it; it ages out; flag off / MediaMTX down = none
//   * bridge.stage() carries `whep` only while his HLS is on air; the pages pass it to the switcher; stage-room.js
//     gives his stream the ⚡ URL from the first render and every poll
//   * liveStep: start-up jump, catch-up / ease-off rates with hysteresis, the big-drift jump (rate-limited), rebuffer
//     margin growth (capped), idle while paused; cache-busters bumped
//   1.99fe: Pepe over WHIP is PARKED (off unless PEPE_WHIP=on) - the first test checks it is inert.
//   NODE_PATH=../node_modules node --test test/pepe-whip.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-whip-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.WHIP_AUTH_PEER;
delete process.env.PEPE_WHIP_KEY_VERSION;
process.env.SECRET_KEY = "test-secret";
const HLS_DIR = path.join(tmp, "hls");
process.env.HLS_PLAYLIST_PATH = path.join(HLS_DIR, "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const W = require(path.join(repo, "webrtc"));

let T = 1_800_000_000_000;
W._setClock(() => T);
const flag = (on) => S.setConfig({ webrtc_enabled: on }, "test");
const auth = (b) => W.whipAuth({ ip: "203.0.113.9", ...b });
const KEY = () => "pw" + crypto.createHmac("sha256", "test-secret").update("pepe-whip:pepe:1").digest("base64url").slice(0, 40);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
});
test.afterEach(async () => { await flag(false); W._setApi(null); delete process.env.PEPE_WHIP_KEY_VERSION; delete process.env.WHIP_AUTH_PEER; });

test("1.99fe parked: without PEPE_WHIP=on Pepe's paths are refused, no bot route, no ⚡; MediaMTX templates untouched", async () => {
  delete process.env.PEPE_WHIP;
  await flag(true);
  for (const b of [{ action: "publish", protocol: "webrtc", path: "pepe", token: KEY() }, { action: "read", protocol: "rtsp", path: "pepe", ip: "127.0.0.1" },
                   { action: "read", protocol: "webrtc", path: "pepe" }, { action: "publish", protocol: "webrtc", path: "stg-pepe", token: "x" }]) {
    assert.equal(await auth(b), 403, JSON.stringify(b));
  }
  W._setApi(async () => ({ items: [{ name: "pepe", ready: true }] }));
  await W.sync();
  assert.equal(W.pepeWhep(), null, "no ⚡ while parked");
  const express = require("express");
  const app = express();
  app.use(express.json());
  S.register(app, { addUser: (q, r, n) => n(), isBotToken: (t) => t === "bot-tok", noTimers: true });
  const srv = await new Promise((ok) => { const x = app.listen(0, "127.0.0.1", () => ok(x)); });
  try {
    const r = await fetch("http://127.0.0.1:" + srv.address().port + "/api/stage/pepe-whip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "bot-tok" }) });
    assert.equal(r.status, 404);
  } finally { srv.close(); }
  const yml = fs.readFileSync(path.join(repo, "deploy", "webrtc", "mediamtx.yml"), "utf8");
  assert.match(yml, /^rtsp: false$/m, "MediaMTX: RTSP stays off");
  assert.doesNotMatch(yml, /^\s+pepe:/m, "MediaMTX: no pepe path");
  assert.ok(!fs.existsSync(path.join(repo, "deploy", "webrtc", "pepe-relay.sh")), "no relay shipped");
  process.env.PEPE_WHIP = "on";                       // the rest of this file tests the parked code itself
});

test("Pepe's bearer: 'pw' + an HMAC of SECRET_KEY for this site's path; rotatable; 'off' = none", () => {
  assert.equal(W.pepePath(), "pepe");
  assert.equal(W.pepeWhipKey(), KEY());
  assert.match(W.pepeWhipKey(), /^pw[A-Za-z0-9_-]{40}$/);
  process.env.PEPE_WHIP_KEY_VERSION = "2";
  assert.notEqual(W.pepeWhipKey(), KEY(), "a new version = a new bearer (the old one stops working)");
  process.env.PEPE_WHIP_KEY_VERSION = "off";
  assert.equal(W.pepeWhipKey(), null);
});

test("auth hook, Pepe's path: his bearer publishes over WHIP (flag on AND off); anything else is refused", async () => {
  for (const on of [false, true]) {
    await flag(on);
    assert.equal(await auth({ action: "publish", protocol: "webrtc", path: "pepe", token: KEY() }), 200, "flag " + on);
    assert.equal(await auth({ action: "publish", protocol: "webrtc", path: "pepe", password: KEY() }), 200, "as a password too");
  }
  assert.equal(await auth({ action: "publish", protocol: "webrtc", path: "pepe", token: KEY() + "x" }), 403);
  assert.equal(await auth({ action: "publish", protocol: "webrtc", path: "pepe", token: "broadcast" }), 403, "his RTMP name isn't a WHIP bearer");
  assert.equal(await auth({ action: "publish", protocol: "webrtc", path: "pepe" }), 401, "no credential = 401 (OBS asks again)");
  for (const proto of ["rtsp", "rtmp", "srt", "hls"]) assert.equal(await auth({ action: "publish", protocol: proto, path: "pepe", token: KEY() }), 403, proto);
  process.env.PEPE_WHIP_KEY_VERSION = "off";
  assert.equal(await auth({ action: "publish", protocol: "webrtc", path: "pepe", token: KEY() }), 403, "switched off");
  assert.equal(await auth({ action: "playback", protocol: "webrtc", path: "pepe" }), 403);
  assert.equal(await auth({ action: "api", path: "pepe" }), 403);
});

test("auth hook, Pepe's path reads: the relay's loopback RTSP always; viewers (WHEP / HLS) only with the flag", async () => {
  for (const on of [false, true]) {
    await flag(on);
    assert.equal(await auth({ action: "read", protocol: "rtsp", path: "pepe", ip: "127.0.0.1" }), 200, "relay, flag " + on);
    assert.equal(await auth({ action: "read", protocol: "rtsp", path: "pepe", ip: "::1" }), 200);
    assert.equal(await auth({ action: "read", protocol: "rtsp", path: "pepe", ip: "203.0.113.9" }), 403, "RTSP from outside");
    assert.equal(await auth({ action: "read", protocol: "rtsp", path: "pepe" }), 403, "no ip = not loopback");
    assert.equal(await auth({ action: "read", protocol: "webrtc", path: "pepe" }), on ? 200 : 403, "WHEP, flag " + on);
    assert.equal(await auth({ action: "read", protocol: "hls", path: "pepe" }), on ? 200 : 403, "HLS, flag " + on);
    assert.equal(await auth({ action: "read", protocol: "rtmp", path: "pepe" }), 403);
  }
  // nothing else that looks like a Pepe path exists
  for (const p of ["Pepe", "pepe2", "stage-pepe", "pepe/x", "stg-pepe-1"]) assert.equal(await auth({ action: "read", protocol: "rtsp", path: p, ip: "127.0.0.1" }), 403, p);
});

test("the other site's Pepe path (stg-pepe on prod) goes to WHIP_AUTH_PEER once, else 403", async () => {
  const http = require("http");
  const seen = [];
  const peer = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => { b += d; });
    req.on("end", () => { const j = JSON.parse(b); seen.push([j.path, j.action, req.headers["x-patv-forwarded"]]); res.statusCode = 200; res.end(); });
  });
  await new Promise((ok) => peer.listen(0, "127.0.0.1", ok));
  try {
    const b = { action: "publish", protocol: "webrtc", path: "stg-pepe", token: "x" };
    assert.equal(await auth(b), 403, "no peer");
    process.env.WHIP_AUTH_PEER = "http://127.0.0.1:" + peer.address().port + "/api/stage/whip-auth";
    assert.equal(await auth(b), 200, "forwarded");
    assert.equal(await W.whipAuth({ ...b, ip: "1.1.1.1" }, { forwarded: true }), 403, "never forwarded twice");
    assert.deepEqual(seen, [["stg-pepe", "publish", "1"]]);
  } finally { peer.close(); }
});

test("bot route POST /api/stage/pepe-whip: URL + bearer for the bot token only, never cached", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  S.register(app, { addUser: (q, r, n) => n(), isBotToken: (t) => t === "bot-tok", noTimers: true });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  try {
    const post = (body) => fetch(base + "/api/stage/pepe-whip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let r = await post({ password: "nope" });
    assert.equal(r.status, 403);
    assert.ok(!JSON.stringify(await r.json()).includes(KEY()));
    r = await post({});
    assert.equal(r.status, 403);
    r = await post({ password: "bot-tok" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(await r.json(), { ok: true, url: "https://stream.publicaccess.tv/whip/pepe", token: KEY(), path: "pepe",
                                       whep: "https://stream.publicaccess.tv/whep/pepe" });
    process.env.PEPE_WHIP_KEY_VERSION = "off";
    r = await post({ password: "bot-tok" });
    assert.equal(r.status, 409);
  } finally { srv.close(); }
});

test("sync: Pepe's path up = pepeWhep (⚡), never a slot beat or a kick; gone / stale / flag off / MediaMTX down = none", async () => {
  const calls = [];
  let items = [];
  W._setApi(async (method, p) => { calls.push(method + " " + p); return method === "GET" ? { items } : {}; });
  items = [{ name: "pepe", ready: true, available: true, source: { type: "webRTCSession", id: "11111111-2222-3333-4444-555555555555" } }];
  assert.deepEqual(await W.sync(), { skipped: true });
  assert.equal(W.pepeWhep(), null, "flag off");
  await flag(true);
  const out = await W.sync();
  assert.deepEqual(out, { live: 0, kicked: 0 }, "not a slot: no beat, no kick");
  assert.ok(!calls.some((c) => c.startsWith("POST")), "never kicked");
  assert.equal(W.pepeWhep(), "https://stream.publicaccess.tv/whep/pepe");
  // MediaMTX v1.21 lists "available" (ready is the older name)
  items = [{ name: "pepe", available: true }];
  await W.sync();
  assert.ok(W.pepeWhep());
  T += 16000;
  assert.equal(W.pepeWhep(), null, "no sync for 15 s = unknown = no ⚡");
  items = [{ name: "pepe", ready: false, available: false }];
  await W.sync();
  assert.equal(W.pepeWhep(), null, "path down");
  items = [{ name: "stg-pepe", ready: true }];
  await W.sync();
  assert.equal(W.pepeWhep(), null, "staging's Pepe path is not prod's");
  items = [{ name: "pepe", ready: true }];
  await W.sync();
  assert.ok(W.pepeWhep());
  W._setApi(async () => { throw new Error("ECONNREFUSED"); });
  const errLog = console.error; console.error = () => {};
  try { await W.sync(); } finally { console.error = errLog; }
  assert.equal(W.pepeWhep(), null, "MediaMTX down");
  W._setApi(async () => ({ items: [{ name: "pepe", ready: true }] }));
  await W.sync();
  assert.ok(W.pepeWhep());
  await flag(false);
  assert.equal(W.pepeWhep(), null, "flag off again");
});

test("bridge.stage(): `whep` only while Pepe's HLS is on air AND his WHIP path is up", async () => {
  const B = require(path.join(repo, "bridge"));
  await flag(true);
  W._setApi(async () => ({ items: [{ name: "pepe", ready: true }] }));
  T = Date.now();
  await W.sync();
  const waitFor = async (pred) => { for (let i = 0; i < 80 && !pred(); i++) await new Promise((r) => setTimeout(r, 100)); return pred(); };
  // no playlist (yet): off air -> no whep
  fs.mkdirSync(HLS_DIR, { recursive: true });
  assert.ok(await waitFor(() => B.stage().active === false), "off air");
  assert.ok(!("whep" in B.stage()));
  fs.writeFileSync(process.env.HLS_PLAYLIST_PATH, "#EXTM3U\n");
  assert.ok(await waitFor(() => B.stage().active === true), "his HLS is fresh -> on air");
  T = Date.now();
  await W.sync();
  assert.equal(B.stage().whep, "https://stream.publicaccess.tv/whep/pepe");
  W._setApi(async () => ({ items: [] }));
  await W.sync();
  assert.ok(!("whep" in B.stage()), "RTMP again: no ⚡");
  T = 1_800_000_000_000;
});

test("pages + stage-room.js: Pepe's stream gets the ⚡ URL from the first render and from every poll", async () => {
  for (const v of ["home.ejs", "room.ejs"]) {
    const src = fs.readFileSync(path.join(repo, "views", v), "utf8");
    assert.ok(src.includes("pepeWhep: <%- JSON.stringify(st.whep || null).replace(/</g, '\\\\u003c') %>"), v + " passes st.whep (escaped)");
    assert.match(src, /stage-player\.js\?v=6/, v + " cache-buster");
    assert.match(src, /stage-room\.js\?v=6/, v + " cache-buster");
  }
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  const sets = [];
  let api = { active: true, slots: [], pepe_here: true };
  const ctx = { PATVStage: { player: () => ({ start: () => {}, stop: () => {}, setSrc: (u, w) => sets.push([u, w === undefined ? "-" : w]), running: () => true }) },
                addEventListener: () => {}, document: { readyState: "complete", visibilityState: "visible" }, location: { hostname: "publicaccess.tv" },
                setInterval: () => 1, clearInterval: () => {},
                fetch: () => Promise.resolve({ json: () => Promise.resolve(api), status: 200 }), Math, Date, JSON, String, Array, Number, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const HLS = "https://publicaccess.tv/hls/broadcast.m3u8";
  const sw = ctx.PATVStage.switcher({ api: "/api/stage", slots: [], pepeOn: true, pepeHere: true, pepeWhep: "https://stream.publicaccess.tv/whep/pepe", watch: false });
  assert.deepEqual(sets.at(-1), [HLS, "https://stream.publicaccess.tv/whep/pepe"], "first render");
  await sw.poll();
  assert.deepEqual(sets.at(-1), [HLS, null], "the poll says RTMP (no whep) -> no ⚡");
  api = { ...api, whep: "https://stream.publicaccess.tv/whep/pepe" };
  await sw.poll();
  assert.deepEqual(sets.at(-1), [HLS, "https://stream.publicaccess.tv/whep/pepe"], "WHIP again");
  api = { ...api, whep: { evil: 1 } };
  await sw.poll();
  assert.deepEqual(sets.at(-1), [HLS, null], "only a string URL counts");
});

// ── the HLS live-latency controller (stage-player.js) ──
function live() {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-player.js"), "utf8");
  const ctx = { window: {}, Math, Number, Infinity };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.PATVStage._live;
}

test("liveStep: start-up jump to bufferedEnd - (TD + margin) (VHS starts ~3 TD back), only once and only while playing", () => {
  const L = live();
  const st = L.state();
  let r = L.step(st, { now: 0, td: 2, lead: 6.4, bufEnd: 100, playing: false });
  assert.equal(r.seekTo, null, "paused / not started: hands off");
  r = L.step(st, { now: 250, td: 2, lead: 6.4, bufEnd: 100, playing: true });
  assert.equal(r.seekTo, 100 - 3, "TD 2 + margin 1.0");
  assert.equal(st.jumps, 1);
  r = L.step(st, { now: 500, td: 2, lead: 3, bufEnd: 100, playing: true });
  assert.equal(r.seekTo, null);
  const st2 = L.state();
  assert.equal(L.step(st2, { now: 0, td: 2, lead: 3.9, bufEnd: 50, playing: true }).seekTo, null, "already close (<= TD + margin + 1): no jump");
});

test("liveStep: rates with hysteresis on the lowest lead over 2 TD + 1 s; a big drift jumps (once per 5 s)", () => {
  const L = live();
  const st = L.state();
  st.primed = true;
  let t = 0;
  const feed = (lead, ms) => { let r; for (const end = t + ms; t < end; t += 250) r = L.step(st, { now: t, td: 2, lead, bufEnd: 1000, playing: true }); return r; };
  let r = feed(1.2, 4000);
  assert.equal(r.rate, 1, "window not full yet");
  r = feed(2.0, 6000);
  assert.equal(r.rate, 1.05, "low 2.0 > margin 1.0 + 0.6 -> catch up");
  r = feed(1.4, 6000);
  assert.equal(r.rate, 1.05, "hysteresis: 1.4 is still above margin + 0.2");
  r = feed(1.1, 6000);
  assert.equal(r.rate, 1, "low <= margin + 0.2 -> normal speed");
  r = feed(0.3, 6000);
  assert.equal(r.rate, 0.96, "low < margin / 2 -> ease off before it runs dry");
  r = feed(0.8, 6000);
  assert.equal(r.rate, 0.96, "until low >= margin");
  r = feed(1.05, 6000);
  assert.equal(r.rate, 1);
  r = feed(6, 5250);
  assert.equal(st.jumps, 1, "low > margin + TD + 2 -> jump");
  assert.equal(r.rate, 1);
  const jumpsBefore = st.jumps;
  feed(6, 4500);
  assert.equal(st.jumps, jumpsBefore, "the window refills first (and never twice inside 5 s)");
});

test("rebuffered: counted; margin +0.5 s (stalls within 10 s count once), up to 2 TD; rate back to 1", () => {
  const L = live();
  const st = L.state();
  st.td = 2; st.rate = 1.05;
  L.rebuffered(st, 0);
  assert.equal(st.rebuffers, 1); assert.equal(st.margin, 1.5); assert.equal(st.rate, 1);
  for (let i = 1; i <= 4; i++) L.rebuffered(st, i * 1000);
  assert.equal(st.rebuffers, 5);
  assert.equal(st.margin, 1.5, "an upstream gap fires several 'waiting' - one step");
  for (let i = 0; i < 10; i++) L.rebuffered(st, 20000 + i * 11000);
  assert.equal(st.margin, 4, "capped at 2 TD");
});

test("margin decay: -0.25 s per 30 s without a stall, back down to the 1.0 s start - only while playing", () => {
  const L = live();
  const st = L.state();
  st.primed = true;
  L.rebuffered(st, 0);
  L.rebuffered(st, 20000);
  assert.equal(st.margin, 2);
  const tick = (t, playing = true) => L.step(st, { now: t, td: 2, lead: 2, bufEnd: 500, playing });
  tick(40000);
  assert.equal(st.margin, 2, "only 20 s since the last stall");
  tick(50000, false);
  assert.equal(st.margin, 2, "paused: no change");
  tick(50000);
  assert.equal(st.margin, 1.75);
  tick(60000);
  assert.equal(st.margin, 1.75, "one step per 30 s");
  for (let t = 80000; t <= 400000; t += 10000) tick(t);
  assert.equal(st.margin, 1, "never below the start margin");
});

test("stage-player.js: VHS may play inside the live window; the controller runs for every player", () => {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-player.js"), "utf8");
  assert.match(src, /allowSeeksWithinUnsafeLiveWindow: true/);
  assert.match(src, /liveui: true/);
  assert.match(src, /sync = liveSync\(p\);/);
});
