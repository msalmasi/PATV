// Offline tests for 1.99et WebRTC (webrtc.js + mainstage.publishGate): /api/turn (signed-in only TURN, the
// HMAC / username format against a known vector, TTL, rate limits, STUN only when signed out / flag off),
// the MediaMTX WHIP auth hook (permission parity with nginx-rtmp's on_publish, reads, browser tokens, the
// prod <-> staging forward), the MediaMTX sync (WHIP = live, orphans kicked, Pepe's RTMP untouched), the
// ⚡ Low latency player fallback (stage-lowlat.js) and that the flag OFF renders no WebRTC UI anywhere.
//   NODE_PATH=../node_modules node --test test/webrtc.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.WHIP_AUTH_PEER;
process.env.SECRET_KEY = "test-secret";
process.env.TURN_SECRET = "test-turn-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const W = require(path.join(repo, "webrtc"));

let T = 1_800_000_000_000;
S._setClock(() => T);
W._setClock(() => T);
let n = 0;
async function mkUser() {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 100000)", [id, "user" + n, "User " + n]);
  return { userId: id, username: "user" + n };
}
async function clear() { for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test"); }
const flag = (on) => S.setConfig({ webrtc_enabled: on }, "test");
const rtmpPub = (name, addr = "1.2.3.4") => S.rtmpCallback({ call: "publish", app: "stage", name, addr, clientid: "9" });
const whipPub = (key, p, extra = {}) => W.whipAuth({ action: "publish", protocol: "webrtc", path: p, token: key, ip: "1.2.3.4", ...extra });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ price_per_min: 1, min_minutes: 2, max_minutes: 30, max_concurrent: 6, start_window_min: 10,
                      idle_grace_min: 5, bookings_per_hour: 50, enabled: true }, "test");
  const rooms = require(path.join(repo, "rooms"));
  await rooms.setStage(rooms.HOUSE_ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4 });
});
test.afterEach(async () => { await clear(); await flag(false); W._resetLimits(); W._setApi(null); });

// ── the setting ──
test("webrtc_enabled: a stage setting, OFF by default, parsed like the other switches", async () => {
  assert.equal(S.DEFAULTS.webrtc_enabled, false);
  assert.equal(S.config().webrtc_enabled, false);
  assert.equal(W.enabled(), false);
  assert.equal(W.webrtcCfg(), null, "views get nothing while off");
  await S.setConfig({ webrtc_enabled: "on" }, "test");
  assert.equal(W.enabled(), true);
  assert.deepEqual(W.webrtcCfg(), { base: "https://stream.publicaccess.tv", turn: "/api/turn" });
  await S.setConfig({ webrtc_enabled: "false" }, "test");
  assert.equal(W.enabled(), false);
});

// ── TURN REST credentials ──
test("TURN: username <expiry>:<userId>, password base64 HMAC-SHA1 - known vector (openssl dgst -sha1 -hmac)", () => {
  const c = W.turnCredentials("user-123", "test-turn-secret", 1_700_000_000_000, 3600);
  assert.equal(c.username, "1700003600:user-123");
  assert.equal(c.credential, "WGSMQpY76C+tSGg/KTJKttP2COs=");
  assert.equal(c.expiry, 1_700_003_600);
  // a userId can never smuggle another ':' (the expiry must stay the first field)
  assert.equal(W.turnCredentials("a:b c", "s", 0, 60).username, "60:a_b_c");
});

async function server() {
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { req.user = req.headers["x-test-user"] ? { userId: req.headers["x-test-user"], username: "t", class: "pleb" } : null; next(); };
  S.register(app, { addUser, isBotToken: () => false, noTimers: true });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  return { srv, base: "http://127.0.0.1:" + srv.address().port };
}

test("/api/turn: 404 while off; STUN only signed out; TURN udp / tcp / turns:5349 for a signed-in user, ~1 h TTL", async () => {
  const { srv, base } = await server();
  try {
    let r = await fetch(base + "/api/turn", { headers: { "x-test-user": "u-9" } });
    assert.equal(r.status, 404, "flag off: no TURN, no route");
    await flag(true);
    r = await fetch(base + "/api/turn");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    let j = await r.json();
    assert.deepEqual(j.iceServers, [{ urls: ["stun:stream.publicaccess.tv:3478"] }], "signed out = STUN only, no credentials");
    r = await fetch(base + "/api/turn", { headers: { "x-test-user": "u-9" } });
    j = await r.json();
    assert.equal(j.iceServers.length, 2);
    const t = j.iceServers[1];
    assert.deepEqual(t.urls, ["turn:stream.publicaccess.tv:3478?transport=udp", "turn:stream.publicaccess.tv:3478?transport=tcp",
                              "turns:stream.publicaccess.tv:5349?transport=tcp"]);
    const [exp, uid] = t.username.split(":");
    assert.equal(uid, "u-9");
    assert.equal(Number(exp), Math.floor(T / 1000) + 3600, "expiry = now + TURN_TTL (1 h)");
    assert.equal(j.ttl, 3600);
    assert.equal(j.expires, Number(exp) * 1000);
    assert.equal(t.credential, crypto.createHmac("sha1", "test-turn-secret").update(t.username).digest("base64"));
    assert.ok(!JSON.stringify(j).includes("test-turn-secret"), "the secret never leaves the server");
    // no secret configured: even a signed-in user gets STUN only
    const keep = process.env.TURN_SECRET;
    delete process.env.TURN_SECRET;
    try { j = await (await fetch(base + "/api/turn", { headers: { "x-test-user": "u-9" } })).json(); } finally { process.env.TURN_SECRET = keep; }
    assert.equal(j.iceServers.length, 1);
  } finally { srv.close(); }
});

test("/api/turn: rate-limited per user (20 / 10 min) and per IP when signed out (30 / 10 min), with Retry-After", async () => {
  await flag(true);
  const { srv, base } = await server();
  try {
    W._resetLimits();
    for (let i = 0; i < W.TURN_LIMIT.user; i++) assert.equal((await fetch(base + "/api/turn", { headers: { "x-test-user": "rl" } })).status, 200);
    let r = await fetch(base + "/api/turn", { headers: { "x-test-user": "rl" } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await fetch(base + "/api/turn", { headers: { "x-test-user": "other" } })).status, 200, "per user");
    for (let i = 0; i < W.TURN_LIMIT.anon; i++) assert.equal((await fetch(base + "/api/turn")).status, 200);
    assert.equal((await fetch(base + "/api/turn")).status, 429, "signed out: per IP");
    T += W.TURN_LIMIT.windowMs + 1;
    assert.equal((await fetch(base + "/api/turn", { headers: { "x-test-user": "rl" } })).status, 200, "the window slides");
  } finally { srv.close(); }
});

// ── the WHIP auth hook ──
test("whip-auth publish = the SAME gate as nginx-rtmp on_publish (parity across every slot state)", async () => {
  await flag(true);
  const cases = [];
  const a = await mkUser(), b = await mkUser(), c = await mkUser(), d = await mkUser();
  const live = await S.book(a, { minutes: 5 });                                  // waiting, key valid
  cases.push(["valid key", live.key, live.slot.stream]);
  cases.push(["wrong key", "psNOTAKEY" + "x".repeat(33), live.slot.stream]);
  cases.push(["public stream name as key", live.slot.stream, live.slot.stream]);
  cases.push(["empty", "", live.slot.stream]);
  cases.push(["relay key from outside", S.relayKey(live.slot.id), live.slot.stream]);
  const ended = await S.book(b, { minutes: 5 });
  await S.end(ended.slot.id, "owner_ended", "test");
  cases.push(["ended slot's old key", ended.key, ended.slot.stream]);
  const banned = await S.book(c, { minutes: 5 });
  await S.ban(c.username, "test", "test");
  cases.push(["banned user (slot ended by the ban)", banned.key, banned.slot.stream]);
  const late = await S.book(d, { minutes: 5 });
  cases.push(["after the deadline", late.key, late.slot.stream, S.deadline(await S.getSlot(late.slot.id)) + 1000]);
  for (const [name, key, stream, at] of cases) {
    const t0 = T;
    if (at) T = at;
    try {
      const gate = await S.publishGate({ key, addr: "1.2.3.4" });
      const whip = await whipPub(key, stream);
      const rtmp = (await rtmpPub(key)).status;
      assert.equal(rtmp >= 300 && rtmp < 400, !!gate, name + ": rtmp follows the gate");
      assert.equal(whip === 200, !!gate, name + ": whip follows the gate (" + whip + ")");
      assert.equal(rtmp >= 300 && rtmp < 400, whip === 200, name + ": rtmp and whip agree");
    } finally { T = t0; }
  }
  // the valid key: only for ITS path, only over WebRTC, and a missing token asks for credentials
  const e = await mkUser();
  const other = await S.book(e, { minutes: 5 });
  assert.equal(await whipPub(live.key, other.slot.stream), 403, "a key never publishes to another slot's path");
  assert.equal(await whipPub(live.key, live.slot.stream, { protocol: "rtmp" }), 403);
  assert.equal(await whipPub("", live.slot.stream), 401);
  assert.equal(await whipPub(live.key, "stage-not-a-path"), 403);
  assert.equal(await W.whipAuth({ action: "api", path: live.slot.stream }), 403);
  // flag off: nothing publishes over WHIP, RTMP unchanged
  await flag(false);
  assert.equal(await whipPub(live.key, live.slot.stream), 403);
  assert.ok((await rtmpPub(live.key)).status >= 300);
});

test("whip-auth reads: public for any open slot's path (WHEP + HLS), refused for unknown / ended / embed / while off", async () => {
  await flag(true);
  const u = await mkUser(), v = await mkUser();
  const r = await S.book(u, { minutes: 5 });
  assert.equal(await W.whipAuth({ action: "read", protocol: "webrtc", path: r.slot.stream }), 200);
  assert.equal(await W.whipAuth({ action: "read", protocol: "hls", path: r.slot.stream }), 200);
  assert.equal(await W.whipAuth({ action: "read", protocol: "hls", path: "stage-0123456789abcdef" }), 403);
  assert.equal(await W.whipAuth({ action: "playback", protocol: "hls", path: r.slot.stream }), 403);
  const em = await S.book(v, { minutes: 5, mode: "embed", embed: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(await W.whipAuth({ action: "read", protocol: "webrtc", path: em.slot.stream }), 403);
  W._resetLimits();
  await S.end(r.slot.id, "cut", "test");
  assert.equal(await W.whipAuth({ action: "read", protocol: "webrtc", path: r.slot.stream }), 403, "ended");
  await flag(false);
  W._resetLimits();
  assert.equal(await W.whipAuth({ action: "read", protocol: "webrtc", path: r.slot.stream }), 403);
});

test("browser WHIP token: owner-only route, 10 minutes, its own slot only; never the stream key", async () => {
  await flag(true);
  const u = await mkUser(), v = await mkUser();
  const r = await S.book(u, { minutes: 5 });
  const r2 = await S.book(v, { minutes: 5 });
  const { srv, base } = await server();
  try {
    let res = await fetch(base + "/api/stage/slots/" + r.slot.id + "/whip", { method: "POST" });
    assert.equal(res.status, 401);
    res = await fetch(base + "/api/stage/slots/" + r.slot.id + "/whip", { method: "POST", headers: { "x-test-user": v.userId } });
    assert.equal(res.status, 404, "someone else's slot");
    res = await fetch(base + "/api/stage/slots/" + r.slot.id + "/whip", { method: "POST", headers: { "x-test-user": u.userId } });
    const j = await res.json();
    assert.equal(j.url, "https://stream.publicaccess.tv/whip/" + r.slot.stream);
    assert.ok(!JSON.stringify(j).includes(r.key), "the stream key is never sent");
    assert.equal(await whipPub(j.token, r.slot.stream), 200);
    assert.equal(await whipPub(j.token, r2.slot.stream), 403, "a token is for its own slot's path");
    assert.equal(await whipPub(j.token.slice(0, -1) + (j.token.endsWith("A") ? "B" : "A"), r.slot.stream), 403, "tampered");
    T += 10 * 60 * 1000 + 1;
    assert.equal(await whipPub(j.token, r.slot.stream), 403, "expired");
    await flag(false);
    res = await fetch(base + "/api/stage/slots/" + r.slot.id + "/whip", { method: "POST", headers: { "x-test-user": u.userId } });
    assert.equal(res.status, 404, "off = no route");
  } finally { srv.close(); }
});

test("HTTP whip-auth: loopback only, never through the public proxy; the other site's prefix goes to WHIP_AUTH_PEER", async () => {
  await flag(true);
  const u = await mkUser();
  const r = await S.book(u, { minutes: 5 });
  const { srv, base } = await server();
  // a fake staging peer that allows exactly one stg- path
  const http = require("http");
  const seen = [];
  const peer = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => { b += d; });
    req.on("end", () => { const j = JSON.parse(b); seen.push([j.path, req.headers["x-patv-forwarded"]]); res.statusCode = j.path === "stg-00000000000000aa" ? 200 : 403; res.end(); });
  });
  await new Promise((ok) => peer.listen(0, "127.0.0.1", ok));
  try {
    const post = (body, h = {}) => fetch(base + "/api/stage/whip-auth", { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(body) });
    const ok = { action: "publish", protocol: "webrtc", path: r.slot.stream, token: r.key };
    assert.equal((await post(ok)).status, 200);
    assert.equal((await post(ok, { "X-Forwarded-For": "9.9.9.9" })).status, 403, "through nginx = refused");
    assert.equal((await post({ ...ok, token: "nope" })).status, 403);
    // prod site, staging path: refused without a peer, forwarded with one (once - never in a loop)
    const stg = { action: "publish", protocol: "webrtc", path: "stg-00000000000000aa", token: "k" };
    assert.equal((await post(stg)).status, 403);
    process.env.WHIP_AUTH_PEER = "http://127.0.0.1:" + peer.address().port + "/api/stage/whip-auth";
    assert.equal((await post(stg)).status, 200);
    assert.equal((await post({ ...stg, path: "stg-00000000000000bb" })).status, 403);
    assert.equal((await post(stg, { "X-PATV-Forwarded": "1" })).status, 403, "a forwarded request is never forwarded again");
    assert.deepEqual(seen, [["stg-00000000000000aa", "1"], ["stg-00000000000000bb", "1"]]);
  } finally { delete process.env.WHIP_AUTH_PEER; srv.close(); peer.close(); }
});

// ── live detection: MediaMTX's API ──
test("sync: a ready WHIP path = the slot is live (MediaMTX HLS + WHEP); gone = off air; orphans kicked; flag off = no sync", async () => {
  const u = await mkUser(), v = await mkUser(), w = await mkUser();
  const r = await S.book(u, { minutes: 10 });
  const rtmp = await S.book(v, { minutes: 10 });
  const gone = await S.book(w, { minutes: 10 });
  await S.end(gone.slot.id, "cut", "test");
  const calls = [];
  let paths = [];
  W._setApi(async (method, p) => {
    calls.push(method + " " + p);
    if (method === "GET") return { itemCount: paths.length, pageCount: 1, items: paths };
    return {};
  });
  paths = [{ name: r.slot.stream, ready: true, source: { type: "webRTCSession", id: "11111111-2222-3333-4444-555555555555" } }];
  assert.deepEqual(await W.sync(), { skipped: true }, "off: MediaMTX isn't even asked");
  assert.equal(calls.length, 0);
  await flag(true);
  // the RTMP slot goes live the old way - untouched by the sync
  assert.equal((await rtmpPub(rtmp.key)).status, 302);
  paths.push({ name: gone.slot.stream, ready: true, source: { type: "webRTCSession", id: "99999999-2222-3333-4444-555555555555" } });
  paths.push({ name: "stg-00000000000000aa", ready: true, source: { type: "webRTCSession", id: "88888888-2222-3333-4444-555555555555" } });
  const out = await W.sync();
  assert.deepEqual(out, { live: 1, kicked: 1 });
  assert.ok(calls.includes("POST /v3/webrtc/sessions/kick/99999999-2222-3333-4444-555555555555"), "the ended slot's publisher is kicked");
  assert.ok(!calls.some((c) => c.includes("88888888")), "the other site's paths are left alone");
  let s = await S.getSlot(r.slot.id);
  assert.equal(s.via, "whip");
  assert.equal(s.status, "active");
  assert.ok(S.isLive(s, T));
  const pub = await S.publicSlots();
  const mine = pub.find((x) => x.id === r.slot.id);
  assert.equal(mine.hls, "https://stream.publicaccess.tv/" + r.slot.stream + "/index.m3u8", "HLS from MediaMTX");
  assert.equal(mine.whep, "https://stream.publicaccess.tv/whep/" + r.slot.stream);
  assert.equal(mine.capture, false, "no snaps / clips off MediaMTX's HLS");
  const theirs = pub.find((x) => x.id === rtmp.slot.id);
  assert.equal(theirs.hls, "https://publicaccess.tv/hls/" + rtmp.slot.stream + ".m3u8", "RTMP slots keep nginx-rtmp's HLS");
  assert.ok(!("whep" in theirs), "no WHEP for RTMP");
  // the beat keeps it live like on_update
  T += 20000; await W.sync(); T += 20000;
  assert.ok(S.isLive(await S.getSlot(r.slot.id), T));
  // flag off: the WHEP field disappears from what pages get
  await flag(false);
  T += 3000;
  assert.ok(!("whep" in (await S.publicSlots()).find((x) => x.id === r.slot.id)));
  await flag(true);
  // the path goes away: publishing stops (publish_done)
  paths = [];
  await W.sync();
  s = await S.getSlot(r.slot.id);
  assert.equal(s.publishing, 0);
  // MediaMTX down: no crash, nothing changes
  W._setApi(async () => { throw new Error("ECONNREFUSED"); });
  const errLog = console.error; console.error = () => {};
  try { assert.deepEqual(await W.sync(), { error: true }); } finally { console.error = errLog; }
});

// ── the ⚡ Low latency player (stage-lowlat.js) ──
function fakeDom() {
  const cls = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c),
    toggle: (c, on) => { if (on === undefined) on = !s.has(c); if (on) s.add(c); else s.delete(c); return on; } }; };
  const el = (tag) => ({ tag, children: [], classList: cls(), attrs: {}, listeners: {}, parentNode: null, paused: false, ended: false, currentTime: 3, volume: 1,
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    click() { (this.listeners.click || []).forEach((f) => f({})); }, play() { return Promise.resolve(); } });
  return { el, document: { createElement: el } };
}
function loadLowlat() {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-lowlat.js"), "utf8");
  const ctx = { window: {}, Promise, String, Number };
  ctx.window.PATVStage = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.PATVStage.rtcWrap;
}
// a fake clock for the auto-hide timers (1.99ey)
function fakeClock() {
  let t = 1000, seq = 0;
  const q = new Map();
  return { now: () => t, set(f, ms) { const id = ++seq; q.set(id, { at: t + ms, f }); return id; }, clear(id) { q.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of q) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        q.delete(next[0]); t = next[1].at; next[1].f();
      }
      t = end;
    } };
}
function rig(storage, extra = {}) {
  const wrap = loadLowlat();
  const { el, document } = fakeDom();
  const box = el("div"), vw = el("div"); box.appendChild(vw);
  const clock = extra.timers || fakeClock();
  if (extra.querySelector) vw.querySelector = extra.querySelector;
  const reconnect = el("div"), unmute = el("button");
  const log = [];
  const hls = { cur: "pepe.m3u8", src() { return this.cur; }, setSrc(u) { this.cur = u; log.push("hls.setSrc " + u); },
                start() { log.push("hls.start"); }, stop() { log.push("hls.stop"); }, state() { return { playing: true, time: 1, muted: true }; } };
  const plays = [];
  const rtc = { play(url, video) { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); plays.push({ url, video, res, rej }); return p; } };
  const p = wrap(hls, { wrap: vw, reconnect, unmute }, { document, storage, rtc, timers: clock, inactivity: extra.inactivity,
                                                         MutationObserver: extra.MutationObserver || null });
  return { p, hls, log, plays, box, vw, btn: p.button, clock };
}
const mem = (init = {}) => { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
const tickP = () => new Promise((r) => setImmediate(r));

test("lowlat: no WHEP URL = no button, plain HLS; WHEP + off = button, still HLS", async () => {
  const { p, log, plays, btn } = rig(mem());
  p.setSrc("slot.m3u8", null); p.start();
  assert.ok(btn.classList.contains("hide"));
  assert.deepEqual(log, ["hls.setSrc slot.m3u8", "hls.start"]);
  p.setSrc("w.m3u8", "https://x/whep/stage-1");
  assert.ok(!btn.classList.contains("hide"), "the toggle shows for a WHIP stream");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.equal(plays.length, 0, "not chosen = never WebRTC");
  assert.equal(p.mode(), "hls");
});

test("lowlat: toggle on -> WebRTC (remembered); an error / timeout falls back to HLS at once, no retry loop", async () => {
  const store = mem();
  const { p, log, plays, btn, vw } = rig(store);
  p.setSrc("w.m3u8", "https://x/whep/stage-1"); p.start();
  log.length = 0;
  btn.click();
  assert.equal(store.m["patv.lowLatency"], "1", "remembered per browser");
  assert.equal(plays.length, 1);
  assert.equal(plays[0].url, "https://x/whep/stage-1");
  assert.equal(p.mode(), "rtc");
  assert.ok(log.includes("hls.stop"));
  assert.equal(vw.children.filter((c) => c.tag === "video").length, 1);
  plays[0].rej(new Error("Low latency timed out"));
  await tickP();
  assert.equal(p.mode(), "hls", "fell back");
  assert.equal(log.at(-1), "hls.start", "the HLS player runs again - never a dead player");
  assert.equal(vw.children.filter((c) => c.tag === "video").length, 0, "the WebRTC video is gone");
  assert.match(btn.title, /isn't available/);
  assert.equal(store.m["patv.lowLatency"], "1", "the choice stays");
  p.setSrc("w.m3u8", "https://x/whep/stage-1");
  assert.equal(plays.length, 1, "the same stream isn't retried by itself");
  p.setSrc("w2.m3u8", "https://x/whep/stage-2");
  assert.equal(plays.length, 2, "another WHIP stream tries WebRTC again");
});

test("lowlat: a connection lost after it started falls back; stop() ends the session; a late answer is closed", async () => {
  const { p, log, plays } = rig(mem({ "patv.lowLatency": "1" }));
  p.setSrc("w.m3u8", "https://x/whep/stage-1"); p.start();
  assert.equal(plays.length, 1, "remembered choice: straight to WebRTC");
  let closed = 0;
  const sess = { close() { closed++; }, onfail: null };
  plays[0].res(sess);
  await tickP();
  assert.equal(p.mode(), "rtc");
  assert.equal(p.state().playing, true);
  log.length = 0;
  sess.onfail();
  assert.equal(p.mode(), "hls");
  assert.deepEqual(log.slice(-2), ["hls.setSrc w.m3u8", "hls.start"]);
  // a fresh one, then stop before it answers: the late session is closed, nothing plays
  p.setSrc("w3.m3u8", "https://x/whep/stage-3");
  assert.equal(plays.length, 2);
  p.stop();
  let late = 0;
  plays[1].res({ close() { late++; } });
  await tickP();
  assert.equal(late, 1);
  assert.equal(p.running(), false);
});

test("lowlat: storage that throws (private mode) = off, and nothing breaks", async () => {
  const bad = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  const { p, plays, btn, log } = rig(bad);
  p.setSrc("w.m3u8", "https://x/whep/stage-1"); p.start();
  assert.equal(plays.length, 0);
  btn.click();
  assert.equal(plays.length, 0, "can't remember = stays on the normal stream");
  assert.ok(log.includes("hls.start"));
  const r2 = rig(null);
  r2.p.setSrc("w.m3u8", "https://x/whep/stage-1"); r2.p.start();
  assert.equal(r2.p.mode(), "hls");
});

// ── 1.99ey: the button auto-hides with the video controls ──
const fire = (el, type, ev = {}) => (el.listeners[type] || []).forEach((f) => f(ev));
const idle = (btn) => btn.classList.contains("idle");

test("lowlat auto-hide (WebRTC): activity shows it, hides after the inactivity delay; hover / focus / pause keep it", async () => {
  const store = mem({ "patv.lowLatency": "1" });
  const { p, plays, btn, box, vw, clock } = rig(store);
  p.setSrc("w.m3u8", "https://x/whep/stage-1"); p.start();
  plays[0].res({ close() {}, onfail: null });
  await tickP();
  assert.equal(p.mode(), "rtc");
  const video = vw.children.find((c) => c.tag === "video");
  assert.ok(!idle(btn), "shown when playback starts");
  clock.advance(1999); assert.ok(!idle(btn));
  clock.advance(1); assert.ok(idle(btn), "hidden after video.js's 2 s inactivityTimeout");
  fire(box, "mousemove"); assert.ok(!idle(btn), "mousemove shows it");
  clock.advance(1500); fire(box, "mousemove"); clock.advance(1500);
  assert.ok(!idle(btn), "each move restarts the timer");
  clock.advance(500); assert.ok(idle(btn));
  // hovered: stays however long
  fire(box, "mousemove"); fire(btn, "mouseenter"); clock.advance(30000);
  assert.ok(!idle(btn), "hovered = stays");
  fire(btn, "mouseleave"); clock.advance(1999); assert.ok(!idle(btn)); clock.advance(1); assert.ok(idle(btn));
  // keyboard: focusing the (hidden) button shows it, and it stays while focused
  fire(btn, "focus"); assert.ok(!idle(btn), "focus shows it");
  clock.advance(30000); assert.ok(!idle(btn));
  fire(btn, "blur"); clock.advance(2000); assert.ok(idle(btn));
  fire(box, "focusin"); assert.ok(!idle(btn), "focus anywhere in the player shows it");
  clock.advance(2000); assert.ok(idle(btn));
  // paused: stays up
  video.paused = true; fire(video, "pause"); assert.ok(!idle(btn), "paused = shown");
  clock.advance(60000); assert.ok(!idle(btn));
  video.paused = false; fire(video, "play"); clock.advance(2000); assert.ok(idle(btn), "playing again = hides again");
});

test("lowlat auto-hide: the tap that wakes the controls never toggles low latency; a later tap / keyboard does", async () => {
  const store = mem({ "patv.lowLatency": "1" });
  const { p, plays, btn, box, clock } = rig(store);
  p.setSrc("w.m3u8", "https://x/whep/stage-1"); p.start();
  plays[0].res({ close() {}, onfail: null });
  await tickP();
  clock.advance(2000); assert.ok(idle(btn));
  fire(box, "touchstart"); assert.ok(!idle(btn), "a tap on the video shows it");
  fire(btn, "click", { detail: 1 });                       // the same tap's synthetic click
  assert.equal(store.m["patv.lowLatency"], "1", "not toggled");
  assert.equal(p.mode(), "rtc");
  assert.equal(plays.length, 1);
  clock.advance(700);
  fire(box, "touchstart");                                 // visible now: a real tap on the button
  fire(btn, "click", { detail: 1 });
  assert.equal(store.m["patv.lowLatency"], "0", "a deliberate tap toggles");
  assert.equal(p.mode(), "hls");
  // a keyboard press (detail 0) right after a revealing tap still counts
  const r = rig(mem({ "patv.lowLatency": "1" }));
  r.p.setSrc("w.m3u8", "https://x/whep/stage-1"); r.p.start();
  r.plays[0].res({ close() {}, onfail: null });
  await tickP();
  r.clock.advance(2000); assert.ok(idle(r.btn));
  fire(r.box, "touchstart");
  fire(r.btn, "click", { detail: 0 });
  assert.equal(r.p.mode(), "hls", "keyboard click works");
});

test("lowlat auto-hide (HLS): follows video.js vjs-user-inactive / vjs-paused; a fallback keeps it up for its error title", async () => {
  const cls = new Set(["video-js", "vjs-user-active"]);
  const vjs = { classList: { contains: (c) => cls.has(c) } };
  let observed = null;
  function MO(cb) { this.observe = (target, opts) => { observed = { cb, target, opts }; }; }
  const store = mem();
  const { p, plays, btn, vw, clock } = rig(store, { MutationObserver: MO, querySelector: (s) => (s === ".video-js" ? vjs : null) });
  assert.equal(observed.target, vw, "watches the player's class changes");
  assert.ok(observed.opts.attributes && observed.opts.subtree);
  p.setSrc("w.m3u8", "https://x/whep/stage-1"); p.start();
  assert.ok(!idle(btn));
  cls.delete("vjs-user-active"); cls.add("vjs-user-inactive"); observed.cb();
  assert.ok(idle(btn), "video.js went inactive = hidden");
  cls.add("vjs-paused"); observed.cb();
  assert.ok(!idle(btn), "paused keeps the controls (and the button)");
  cls.delete("vjs-paused"); observed.cb();
  assert.ok(idle(btn));
  fire(btn, "focus"); assert.ok(!idle(btn), "focus shows it on HLS too");
  fire(btn, "blur"); assert.ok(idle(btn));
  cls.delete("vjs-user-inactive"); cls.add("vjs-user-active"); observed.cb();
  assert.ok(!idle(btn), "active again = shown");
  // turn it on, it fails -> back on HLS with the error title, pinned while the notice is fresh
  fire(btn, "click", { detail: 1 });
  plays[0].rej(new Error("Low latency timed out"));
  await tickP();
  assert.equal(p.mode(), "hls");
  assert.match(btn.title, /isn't available/, "the error title is kept");
  cls.delete("vjs-user-active"); cls.add("vjs-user-inactive"); observed.cb();
  assert.ok(!idle(btn), "the fallback notice keeps it up");
  clock.advance(6001);
  assert.ok(idle(btn), "then it hides with the controls");
  assert.match(btn.title, /isn't available/);
});

// ── flag off: no WebRTC UI anywhere ──
const ejs = require("ejs");
const RTC = /webrtc-client\.js|stage-lowlat\.js|stage-golive-rtc\.js|webrtc\.css|⚡|paneRtc|whipUrl|WHIP/;
async function renderHome(extra) {
  return ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
    username: null, me: null, mine: null, S: {}, rooms: [], room: null, roomLive: null, stage: { active: false }, top: [], tops: [],
    story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: false, stageAdmin: null,
    frontInfo: { id: "PepeFrog.Room", slug: "pepefrog-room", title: "Pepe's Pad", pinned: false, owner: null, boost: 0 }, pepeHere: true,
    featuredPrice: 0, slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "",
    boostMark: require(path.join(repo, "boostmark")).boostMark, ul: (x) => String(x == null ? "" : x),
  }, extra));
}
async function renderRoom(extra) {
  return ejs.renderFile(path.join(repo, "views", "room.ejs"), Object.assign({
    user: "u", signedIn: true, linked: true, room: { name: "Houseplants", slug: "plant_based_chatting", count: 2, live: true, topic: "", platform: "camfrog",
      description: "Plants", owner: "pb", ownerUser: "pb", camfrogName: "Plant Based Chatting" },
    initial: { room: {}, members: [], mic: [], feed: [], cursor: 0 }, onStage: false, stage: {}, latest: [],
  }, extra));
}
async function renderBook(extra) {
  return ejs.renderFile(path.join(repo, "views", "stageBook.ejs"), Object.assign({
    user: "bob", me: { userId: "u1", username: "bob", points_balance: 5000 }, C: S.config(), rtmpServer: "rtmp://stream.publicaccess.tv/stage", staff: false,
    rooms: [{ id: "PepeFrog.Room", slug: "pepefrog-room", title: "Pepe's Pad", slot_count: 1, slot_price: 0, approval: false, house: true, owner: null }],
    pick: "PepeFrog.Room", twitchUrl: null,
  }, extra));
}
test("flag OFF renders no WebRTC UI (home, pad, /stage); ON adds the toggle scripts, the WHIP pane and OBS WHIP box", async () => {
  const on = { webrtcCfg: () => ({ base: "https://stream.publicaccess.tv", turn: "/api/turn" }) };
  const offFn = { webrtcCfg: () => null };
  for (const [name, render] of [["home", renderHome], ["room", renderRoom], ["stage", renderBook]]) {
    const plain = await render({});
    const off = await render(offFn);
    assert.doesNotMatch(plain, RTC, name + ": no WebRTC without the setting");
    assert.doesNotMatch(off, RTC, name + ": no WebRTC while off");
    const html = await render(on);
    assert.match(html, /webrtc-client\.js\?v=1/, name);
    assert.match(html, /webrtc\.css\?v=2/, name);
  }
  assert.match(await renderHome(on), /stage-lowlat\.js\?v=2"><\/script>\s*<\/?[a-z%]*[^]*stage-room\.js\?v=6/);
  assert.match(await renderRoom(on), /stage-lowlat\.js\?v=2/);
  const book = await renderBook(on);
  assert.match(book, /id="tabRtc"[^>]*>⚡ Browser · ultra-low latency/);
  assert.match(book, /Go live from your browser \(camera \/ screen\) — ultra-low latency/);
  assert.match(book, /id="paneRtc"[^>]*data-base="https:\/\/stream\.publicaccess\.tv"/);
  assert.match(book, /Service: WHIP/);
  assert.match(book, /id="whipUrl"/);
  assert.match(book, /id="rtcKbps"/);
  assert.match(book, /stage-golive-rtc\.js\?v=1/);
  // the shared player script only wraps when stage-lowlat.js defined PATVStage.rtcWrap
  const room = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  assert.match(room, /if \(PATVStage\.rtcWrap\) player = PATVStage\.rtcWrap\(player,/);
});
