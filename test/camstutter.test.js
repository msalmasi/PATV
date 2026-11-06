// camstutter (2026-11-05): relayed live cams - a viewer whose session the SERVER ended (MediaMTX closes every reader of a cam when its
// relay is re-published: Pepe switching it to re-encode, a dead-relay restart, a re-open) reconnects at once, on the session's DTLS
// close, instead of after ICE "disconnected" + the 5-s blip grace. Behind the live-cam setting fast_end (off on prod, on on staging).
//   * webrtc-client.js in a sandbox with a fake RTCPeerConnection: watch(.., {fastEnd: true}) fails the session the moment its DTLS
//     transport goes closed / failed (and one already closed when the session starts - after the caller set onfail); without
//     fastEnd, or a browser without RTCDtlsTransport, nothing changes (the 'disconnected' + 5 s path stays)
//   * livecam.js: the fast_end field (default per STAGING, admin checkbox, never sent to Pepe), the watch tickets carry it
//   * the three live-cam pages pass it (stage-mic, the cam strip, the ▶ Live popover); cache-busters bumped
//   * the MediaMTX kick: one route (the second only when the first route doesn't exist), no second "session not found"
//   node --test test/camstutter.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

// ── a fake browser for webrtc-client.js ──────────────────────────────────────────────────────────────────────────────────
class Emitter {
  constructor() { this.l = {}; }
  addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
  removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter((x) => x !== f); }
  emit(t) { (this.l[t] || []).slice().forEach((f) => f({ type: t })); }
}
function sandbox({ dtls = true, dtlsState = "connected" } = {}) {
  const calls = [];
  const pcs = [];
  class FakeDtls extends Emitter { constructor() { super(); this.state = dtlsState; } set(s) { this.state = s; this.emit("statechange"); } }
  class FakePC extends Emitter {
    constructor() {
      super();
      this.connectionState = "new"; this.iceGatheringState = "complete"; this.closed = false;
      this.dtls = dtls ? new FakeDtls() : null;
      this.rx = dtls ? { transport: this.dtls } : {};
      pcs.push(this);
    }
    addTransceiver() { return {}; }
    createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0 offer" }); }
    setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
    setRemoteDescription() {
      setTimeout(() => {
        if (this.ontrack) this.ontrack({ receiver: this.rx, track: { kind: "video" } });
        this.connectionState = "connected"; this.emit("connectionstatechange");
      }, 1);
      return Promise.resolve();
    }
    getReceivers() { return [this.rx, this.rx]; }        // (bundled: the same transport twice - watched once)
    close() { this.closed = true; this.connectionState = "closed"; }
    state(s) { this.connectionState = s; this.emit("connectionstatechange"); }
  }
  class FakeStream { constructor() { this.t = []; } addTrack(t) { this.t.push(t); } }
  const fetch = (url, o) => {
    calls.push([(o && o.method) || "GET", String(url)]);
    if (String(url).startsWith("/api/turn")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ iceServers: [] }) });
    if (o && o.method === "POST") return Promise.resolve({ status: 201, headers: { get: () => "/whep/res/1" }, text: () => Promise.resolve("v=0 answer") });
    return Promise.resolve({ ok: true, status: 200 });
  };
  const ctx = { console, setTimeout, clearTimeout, Promise, URL, Error, Object, Math, Date, fetch, RTCPeerConnection: FakePC, MediaStream: FakeStream };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read("public", "js", "webrtc-client.js"), ctx);
  return { R: ctx.window.PATVRtc, pcs, calls };
}
function video() {
  const v = new Emitter();
  Object.assign(v, { paused: false, readyState: 4, muted: false, playsInline: false, srcObject: null, setAttribute() {}, play: () => Promise.resolve() });
  return v;
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function watched(opts, sb) {
  const { R, pcs, calls } = sb || sandbox();
  const ss = await R.watch("https://stream.example/room-0123456789abcdef/whep?pt=t", video(), Object.assign({ timeout: 3000 }, opts));
  const fails = [];
  ss.onfail = () => fails.push(Date.now());
  return { ss, pc: pcs[pcs.length - 1], fails, calls };
}

test("fastEnd: the server's DTLS close ends the session at once -> onfail (the page reconnects); the resource is let go", async () => {
  const { ss, pc, fails, calls } = await watched({ fastEnd: true });
  await tick();
  assert.equal(fails.length, 0, "a live session isn't failed");
  pc.dtls.set("connected");
  assert.equal(fails.length, 0, "a DTLS state that isn't an end: nothing");
  pc.dtls.set("closed");
  assert.equal(fails.length, 1, "closed by the server: onfail at once");
  assert.ok(ss.closed && pc.closed, "the session and its peer connection are closed");
  assert.ok(calls.some(([m, u]) => m === "DELETE" && /\/whep\/res\/1$/.test(u)), "the WHEP resource is deleted (as on any end)");
  pc.dtls.set("failed");
  pc.state("failed");
  assert.equal(fails.length, 1, "once only");
});

test("fastEnd: a DTLS 'failed' ends it too; one already closed when the session starts fails once the caller set onfail", async () => {
  const a = await watched({ fastEnd: true });
  a.pc.dtls.set("failed");
  assert.equal(a.fails.length, 1);
  const sb = sandbox({ dtlsState: "closed" });
  const b = await watched({ fastEnd: true }, sb);
  assert.equal(b.fails.length, 0, "(not inside session() - onfail isn't set yet there)");
  await tick();
  assert.equal(b.fails.length, 1, "...on the next turn");
});

test("without fastEnd (the setting off, an older page) the DTLS close changes nothing: 'disconnected' + 5 s, as before", async () => {
  for (const opts of [{}, { fastEnd: false }, { fastEnd: "yes" }]) {
    const { pc, fails } = await watched(opts);
    pc.dtls.set("closed");
    await tick();
    assert.equal(fails.length, 0, JSON.stringify(opts));
  }
  const { ss } = await watched({});
  assert.equal(typeof ss.close, "function");
});

test("a browser without RTCDtlsTransport: nothing breaks, the old path stays", async () => {
  const { pc, fails, ss } = await watched({ fastEnd: true }, sandbox({ dtls: false }));
  await tick();
  assert.equal(fails.length, 0);
  pc.state("failed");
  assert.equal(fails.length, 1, "a failed connection still ends it");
  assert.ok(ss.closed);
});

test("our own close never counts as the server's (no onfail)", async () => {
  const { ss, pc, fails } = await watched({ fastEnd: true });
  ss.close();
  pc.dtls.set("closed");
  assert.equal(fails.length, 0);
});

test("measured in the fake: a re-publish's freeze until the page reconnects - ~0 s with fastEnd vs 5 s + ICE's own detection without", async () => {
  const on = await watched({ fastEnd: true });
  const off = await watched({});
  const t0 = Date.now();
  on.pc.dtls.set("closed"); off.pc.dtls.set("closed");      // the server closes both sessions
  assert.equal(on.fails.length, 1);
  assert.ok(on.fails[0] - t0 < 50, `fastEnd: onfail after ${on.fails[0] - t0} ms`);
  // without it the page waits for the browser's ICE "disconnected" (Chrome: ~2.5-5 s after the last packet), then 5 s more
  off.pc.state("disconnected");
  await tick(60);
  assert.equal(off.fails.length, 0, "...still waiting (the 5-s blip grace)");
  off.ss.close();
});

// ── the setting and the tickets ────────────────────────────────────────────────────────────────────────────────────────
test("livecam.js: fast_end is a site switch - off on prod, on on staging; the admin page has it; Pepe never gets it", () => {
  const src = read("livecam.js");
  assert.match(src, /fast_end:\s*\{ def: STAGING, bool: true \}/);
  const botKeys = src.match(/const BOT_KEYS = \[([^\]]+)\]/)[1];
  assert.ok(!botKeys.includes("fast_end"), "not one of the keys sent to Pepe");
  assert.match(read("views", "admin", "pepeLivecams.ejs"), /<input type="checkbox" name="fast_end">/);
  delete require.cache[require.resolve(path.join(repo, "livecam"))];
  delete process.env.STAGING;
  const LC = require(path.join(repo, "livecam"));
  assert.equal(LC.DEFAULTS.fast_end, false, "prod default off");
  assert.equal(LC.normalize({ fast_end: true }).cfg.fast_end, true);
  assert.equal(LC.normalize({ fast_end: "off" }).cfg.fast_end, false);
  assert.ok(LC.normalize({ fast_end: "maybe" }).errors.fast_end, "a bad value is refused");
  // the two ticket replies a live cam is watched with carry it (start: ▶ Live / the strip; stageWatch: the mic stage, pins, rooms)
  const start = src.slice(src.indexOf("async function start("), src.indexOf("async function start(") + 9000);
  assert.match(start, /expires: t \+ TICKET_MS, fast_end: cfg\(\)\.fast_end === true \}/);
  const sw = src.slice(src.indexOf("async function stageWatch("), src.indexOf("function stageUnwatch("));
  assert.match(sw, /if \(beatOnly\) return \{ ok: true, state: stateOf\(S, t\) \};\s*return \{ ok: true, whep:[^]*?fast_end: cfg\(\)\.fast_end === true \}/);
});

test("livecam.js start(): a viewer's ticket says fast_end as the setting is (a real request)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "camstutter-test-"));
  const cwd = process.cwd();
  process.chdir(tmp);
  process.env.SECRET_KEY = "test-secret";
  delete process.env.STAGING;
  for (const m of ["livecam", "dbUtils", "padaccess", "webrtc", "bridge", "premium"]) delete require.cache[require.resolve(path.join(repo, m))];
  const express = require("express");
  const { runQuery } = require(path.join(repo, "dbUtils"));
  const LC = require(path.join(repo, "livecam"));
  const PA = require(path.join(repo, "padaccess"));
  const W = require(path.join(repo, "webrtc"));
  const B = require(path.join(repo, "bridge"));
  W.enabled = () => true;
  LC._setKick(() => {});
  const R = { id: "Room.CS", slug: "room-cs", cams: true, livecams: true, members: [{ login: "alice", on_cam: true }] };
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('v1', 'v1_patv', 'v1', 'x', 'pleb', 'viewer1')");
  await PA.init();
  await PA.load();
  await LC.init();
  const staff = { class: "Admin", userId: "staff", username: "boss" };
  await LC.save(staff, { cfg: { enabled: true } });
  B._rooms.set(R.id, R);
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, class: "pleb", username: u } : null; next(); };
  LC.register(app, { addUser, isBotToken: (t) => t === "bot", bySlug: (s) => (s === R.slug ? R : null), isLive: () => true });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
  const post = async (p, body, u) => { const r = await fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) }); return r.json().catch(() => ({})); };
  try {
    await post("/api/bridge/livecam", { password: "bot", cap: true });
    const off = await post(`/api/rooms/${R.slug}/livecam`, { login: "alice" }, "v1");
    assert.equal(off.ok, true, JSON.stringify(off));
    assert.equal(off.fast_end, false, "prod default: off");
    await LC.save(staff, { cfg: { fast_end: true } });
    const on = await post(`/api/rooms/${R.slug}/livecam`, { login: "alice" }, "v1");
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.equal(on.fast_end, true, "the switch on: the ticket says so");
  } finally {
    server.close();
    process.chdir(cwd);
  }
});

test("the live-cam pages pass the ticket's fast_end to watch() (only a real true), and their cache-busters moved", () => {
  const n = (f) => (read("public", "js", f).match(/fastEnd: d2?\.fast_end === true/g) || []).length;
  assert.equal(n("stage-mic.js"), 2, "stage-mic.js: start + rewatch");
  assert.equal(n("pad-camstrip.js"), 2, "pad-camstrip.js: start + rewatch");
  assert.equal(n("pad-livecam.js"), 2, "pad-livecam.js: start + rewatch (the strip adopts its session)");
  assert.match(read("public", "js", "webrtc-client.js"), /session\(pc, resource, \{ fastEnd: o\.fastEnd === true \}\)/);
  const room = read("views", "room.ejs");
  assert.ok(room.includes("/public/js/webrtc-client.js?v=7") && !room.includes("webrtc-client.js?v=6"));
  assert.ok(room.includes("/public/js/stage-mic.js?v=18") && room.includes("/public/js/pad-livecam.js?v=13"));
  assert.ok(read("views", "partials", "cam-strip.ejs").includes("/public/js/pad-camstrip.js?v=7"));
  assert.ok(read("views", "home.ejs").includes("/public/js/webrtc-client.js?v=7") && read("views", "home.ejs").includes("/public/js/stage-mic.js?v=18"));
  assert.ok(read("views", "stageBook.ejs").includes("/public/js/webrtc-client.js?v=7"));
});

// ── the MediaMTX kick: one route ───────────────────────────────────────────────────────────────────────────────────────────
async function kickWith(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.method + " " + req.url); handler(req, res); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const old = process.env.MEDIAMTX_API;
  process.env.MEDIAMTX_API = "http://127.0.0.1:" + server.address().port;
  const LC = require(path.join(repo, "livecam"));
  try {
    await new Promise((r) => LC._kickHttp("12345678-1234-1234-1234-123456789abc", r));
  } finally {
    if (old == null) delete process.env.MEDIAMTX_API; else process.env.MEDIAMTX_API = old;
    server.close();
  }
  return hits;
}
test("kick: MediaMTX v1.21 has the first route - one request (kicked, or its JSON 'session not found'), never the second", async () => {
  let hits = await kickWith((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  assert.deepEqual(hits, ["POST /v3/webrtcsessions/kick/12345678-1234-1234-1234-123456789abc"]);
  hits = await kickWith((req, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"session not found"}'); });
  assert.equal(hits.length, 1, "a session that's gone already: one request, one log line on the VPS (was two)");
});
test("kick: a MediaMTX without that route (another version: a plain 404) gets the other route", async () => {
  const hits = await kickWith((req, res) => {
    if (req.url.startsWith("/v3/webrtcsessions/")) { res.writeHead(404, { "content-type": "text/plain" }); res.end("404 page not found"); }
    else { res.writeHead(200); res.end("{}"); }
  });
  assert.deepEqual(hits, ["POST /v3/webrtcsessions/kick/12345678-1234-1234-1234-123456789abc", "POST /v3/webrtc/sessions/kick/12345678-1234-1234-1234-123456789abc"]);
});
test("kick: a bad id never reaches MediaMTX", async () => {
  const LC = require(path.join(repo, "livecam"));
  let called = false;
  LC._kickHttp("../../v3/config", () => { called = true; });
  await tick(20);
  assert.equal(called, false);
});
