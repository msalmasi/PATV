// Offline tests for web push-to-talk clips (1.99bk): Pepe acks a clip's steps (queued -> waiting for
// the mic -> playing -> played / couldn't get the mic) and the site keeps them in order, keeps an
// unfinished clip long enough for a busy room's wait, and the clip line renders each state. Also
// loads public/js/room-bridge.js in a stub DOM: the clip line text, iOS detection, and the
// push-to-talk "released before the mic opened" path letting the microphone go at once.
//   node --test test/relayclip.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relayclip-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const relay = require(path.join(repo, "bridge-relay"));

const R = { id: "Room.Clip", slug: "room-clip", micRelay: true, relay: true, members: [], cmds: {} };
let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('c1', 'c1_patv', 'c1', 'x', 'alice')");
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  relay.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug: (s) => (s === R.slug ? R : null), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

async function postClip() {
  relay._hits.clear();
  const r = await fetch(base + "/api/rooms/" + R.slug + "/clip", { method: "POST",
    headers: { "content-type": "audio/webm", "x-clip-secs": "3.0", "x-test-user": "c1" }, body: Buffer.alloc(2000, 1) });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  return d.id;
}
const mine = (id) => relay.mineFor("c1", R.id).find((x) => x.id === id);

test("a clip's steps reach the user in order: queued -> waiting -> playing -> played", async () => {
  const id = await postClip();
  const offered = relay.takeJobs(new Set([R.id])).find((j) => j.id === id);
  assert.ok(offered && offered.kind === "clip" && offered.camfrog === "alice");
  assert.equal(mine(id).state, "claimed");
  relay.applyAcks([{ id, ok: true, msg: "queued for the mic", state: "queued" }]);
  assert.equal(mine(id).state, "queued");
  relay.applyAcks([{ id, ok: true, msg: "waiting for the mic…", state: "waiting" }]);
  assert.equal(mine(id).state, "waiting");
  // not re-offered to Pepe while it waits (it was acked)
  assert.equal(relay.takeJobs(new Set([R.id])).some((j) => j.id === id), false);
  // one sync can carry two steps, and a late older step must not undo a newer one
  relay.applyAcks([{ id, ok: true, msg: "playing on the mic now", state: "playing" }, { id, ok: true, msg: "waiting for the mic…", state: "waiting" }]);
  assert.equal(mine(id).state, "playing");
  relay.applyAcks([{ id, ok: true, msg: "played" }]);
  const m = mine(id);
  assert.equal(m.state, "done");
  assert.equal(m.ok, true);
  assert.equal(m.msg, "played");
  relay.applyAcks([{ id, ok: true, msg: "queued for the mic", state: "queued" }]);
  assert.equal(mine(id).state, "done", "a progress step after the final one is ignored");
});

test("couldn't get the mic: final, not ok", async () => {
  const id = await postClip();
  relay.takeJobs(new Set([R.id]));
  relay.applyAcks([{ id, ok: true, msg: "queued for the mic", state: "queued" }, { id, ok: true, msg: "waiting", state: "waiting" }]);
  relay.applyAcks([{ id, ok: false, msg: "couldn't get the mic - the room's mic stayed busy. Try again" }]);
  const m = mine(id);
  assert.equal(m.state, "done");
  assert.equal(m.ok, false);
  assert.match(m.msg, /couldn't get the mic/);
});

test("an older Pepe (no states) still works: its first ack is final, later ones update it", async () => {
  const id = await postClip();
  relay.takeJobs(new Set([R.id]));
  relay.applyAcks([{ id, ok: true, msg: "queued for the mic - waiting for a free slot" }]);
  assert.equal(mine(id).state, "done");
  relay.applyAcks([{ id, ok: true, msg: "playing on the mic now" }]);
  assert.equal(mine(id).msg, "playing on the mic now");
});

test("a waiting clip outlives the 3-minute job TTL; a finished one goes 3 minutes after it finished", async () => {
  const id = await postClip();
  relay.takeJobs(new Set([R.id]));
  relay.applyAcks([{ id, ok: true, msg: "waiting", state: "waiting" }]);
  const j = relay._jobs.get(id);
  j.at = Date.now() - 5 * 60 * 1000;                  // queued 5 min ago, still waiting for the mic
  relay._sweep(Date.now());
  assert.ok(relay._jobs.has(id), "a waiting clip was dropped at 5 min");
  relay.applyAcks([{ id, ok: true, msg: "played" }]);
  relay._sweep(Date.now() + 60 * 1000);
  assert.ok(relay._jobs.has(id), "the result vanished a minute after it played");
  relay._sweep(Date.now() + 4 * 60 * 1000);
  assert.equal(relay._jobs.has(id), false);
  // an open clip still has a ceiling
  const id2 = await postClip();
  relay._jobs.get(id2).at = Date.now() - 9 * 60 * 1000;
  relay._sweep(Date.now());
  assert.equal(relay._jobs.has(id2), false);
});

// ── the browser side, in a stub DOM ──
class Cls {
  constructor() { this.s = new Set(); }
  add(...c) { c.forEach((x) => this.s.add(x)); }
  remove(...c) { c.forEach((x) => this.s.delete(x)); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) { if (on === undefined) on = !this.s.has(c); if (on) this.s.add(c); else this.s.delete(c); return on; }
}
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.classList = new Cls(); this.textContent = ""; }
  set className(v) { this.classList = new Cls(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)); }
  get className() { return [...this.classList.s].join(" "); }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t, e) { (this.listeners[t] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, e || {}))); }
}

function loadClient({ ua = "Mozilla/5.0 (Windows NT 10.0)", platform = "Win32", touch = 0, gum } = {}) {
  const docListeners = {};
  const sessionLog = [];
  const audioSession = { set type(v) { sessionLog.push(v); }, get type() { return sessionLog[sessionLog.length - 1] || "auto"; } };
  const win = {
    MediaRecorder: class { constructor(s) { this.stream = s; this.state = "inactive"; this.mimeType = "audio/webm"; }
      static isTypeSupported(t) { return t === "audio/webm"; }
      start() { this.state = "recording"; } stop() { this.state = "inactive"; if (this.onstop) this.onstop(); } },
  };
  const ctx = {
    window: win, console,
    navigator: { userAgent: ua, platform, maxTouchPoints: touch, audioSession,
      mediaDevices: { getUserMedia: gum || (() => new Promise(() => {})) } },
    document: { createElement: (t) => new El(t), hidden: false, addEventListener: (t, fn) => { docListeners[t] = fn; } },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    fetch: () => Promise.resolve({ json: () => ({ ok: true }) }), Blob: class { constructor(p, o) { this.type = o.type; } },
    Date, JSON, Math, Number, String, Object, Array, Promise, isFinite, Uint8Array,
  };
  ctx.window.MediaRecorder = win.MediaRecorder;
  ctx.MediaRecorder = win.MediaRecorder;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8"), ctx);
  return { PATV: ctx.window.PATVRoom, sessionLog, ctx };
}

test("clip line text for each state (stub render)", () => {
  const { PATV } = loadClient();
  const S = PATV.clipStatus;
  assert.equal(S(null), "");
  assert.equal(S({ state: "claimed" }), "sent — waiting for Pepe…");
  assert.equal(S({ state: "queued", ok: true }), "queued for the mic…");
  assert.equal(S({ state: "waiting", ok: true }), "waiting for the mic…");
  assert.equal(S({ state: "playing", ok: true }), "playing on the mic now");
  assert.equal(S({ state: "done", ok: true, msg: "played" }), "played");
  assert.equal(S({ state: "done", ok: false, msg: "couldn't get the mic - the room's mic stayed busy. Try again" }), "couldn’t get the mic, try again");
  assert.equal(S({ state: "done", ok: false, msg: "the mic stayed busy - dropped" }), "couldn’t get the mic, try again", "older Pepe's wording");
  assert.equal(S({ state: "done", ok: false, msg: "you're mic-blocked right now" }), "not sent — you're mic-blocked right now");

  // rendered by the push-to-talk box from the live view's `mine`
  const host = new El("div");
  const p = PATV.ptt(host, "room-clip");
  const line = host.children[1];
  p.update({ room: { micRelay: true }, mine: [{ id: "a", kind: "clip", state: "waiting", ok: true, msg: "waiting" }] });
  assert.equal(line.textContent, "🎙 your clip: waiting for the mic…");
  p.update({ room: { micRelay: true }, mine: [{ id: "a", kind: "clip", state: "done", ok: true, msg: "played" }] });
  assert.equal(line.textContent, "🎙 your clip: played");
});

test("iOS detection (iPhone, iPadOS desktop UA) and desktop", () => {
  assert.equal(loadClient({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", platform: "iPhone" }).PATV._ios, true);
  assert.equal(loadClient({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", touch: 5 }).PATV._ios, true);
  assert.equal(loadClient({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", touch: 0 }).PATV._ios, false);
  assert.equal(loadClient({ ua: "Mozilla/5.0 (Linux; Android 14)", platform: "Linux armv8l", touch: 5 }).PATV._ios, false);
});

test("push-to-talk: a hold released before the mic opened lets the mic go at once; a real hold records and releases", async () => {
  let resolveGum, stopped = 0;
  const track = { stop: () => { stopped++; } };
  const stream = { getTracks: () => [track] };
  const gum = () => new Promise((r) => { resolveGum = r; });
  const { PATV, sessionLog } = loadClient({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)", platform: "iPhone", gum });
  const host = new El("div");
  const p = PATV.ptt(host, "room-clip");
  p.update({ room: { micRelay: true }, mine: [] });
  const btn = host.children[0].children[0];
  // press, the permission prompt takes a while, the finger lifts after 0.6 s, THEN the mic opens
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    btn.fire("pointerdown");
    assert.equal(sessionLog[sessionLog.length - 1], "play-and-record");
    t += 600; btn.fire("pointerup");
    resolveGum(stream); await new Promise((r) => setImmediate(r));
    assert.equal(stopped, 1, "the mic track wasn't stopped");
    assert.equal(btn.getAttribute("aria-pressed"), "false", "it started recording anyway");
    assert.equal(sessionLog[sessionLog.length - 1], "auto", "the audio session wasn't handed back");
    // a normal hold: down, mic opens while held, up after 2 s -> recorded, mic released in the gesture
    t += 1000; btn.fire("pointerdown");
    resolveGum(stream); await new Promise((r) => setImmediate(r));
    assert.equal(btn.getAttribute("aria-pressed"), "true");
    t += 2000; btn.fire("pointerup");
    assert.equal(stopped, 2, "the mic track wasn't stopped when the hold ended");
    assert.equal(btn.getAttribute("aria-pressed"), "false");
    assert.equal(sessionLog[sessionLog.length - 1], "auto");
  } finally {
    Date.now = realNow;
  }
});
