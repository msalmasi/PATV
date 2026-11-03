// Room Dock rollout and the small APIs that reuse the existing relay/audio/PTT widgets.
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const repo = path.resolve(__dirname, ".."), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "paddock-test-"));
process.chdir(tmp); process.env.SECRET_KEY = "fixture-secret"; delete process.env.STAGING;
const db = require(path.join(repo, "dbUtils")), P = require(path.join(repo, "paddock"));
const SP = require(path.join(repo, "siteperms")), express = require("express");
const admin = { userId: "admin", username: "fixture-admin", class: "Admin" };
const staff = { userId: "staff", username: "fixture-staff", class: "Staff" };
const member = { userId: "member", username: "fixture-member", class: "pleb" };
let server, base;
test.before(async () => {
  await P.init();
  const app = express(); app.use(express.json());
  P.register(app, { addUser(req, res, next) { req.user = { admin, staff, member }[req.get("x-test-user")] || null; next(); } });
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
async function request(method, body, user = "admin", headers = {}) {
  const r = await fetch(base + "/api/admin/paddock", { method, headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...headers }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: r.status, headers: r.headers, data: await r.json() };
}
const post = (body, user, headers = { "X-Requested-With": "fetch" }) => request("POST", body, user, headers);

test("rollout defaults off; strict mode validation retains the previous setting", async () => {
  assert.deepEqual(P.current(), { v: 0, cfg: { mode: "off" } });
  for (const user of [null, member, staff, admin]) assert.equal(P.viewerOn(user), false);
  for (const value of [null, true, 1, [], {}, "all", "__proto__"]) {
    const result = P.normalize({ mode: value }, { base: { mode: "staff" } });
    assert.equal(result.cfg.mode, "staff"); assert.equal(result.errors.mode, "invalid");
  }
  assert.deepEqual(P.normalize({}).cfg, { mode: "off" });
  assert.deepEqual(P.normalize({ mode: " EVERYONE " }).cfg, { mode: "everyone" });
  await P.save(admin, { cfg: { mode: "staff" } });
  const before = P.current();
  await assert.rejects(P.save(admin, { cfg: { mode: "bad" } }), e => e.status === 400);
  assert.deepEqual(P.current(), before);
});

test("staff audience delegates to pads.manage_any; everyone includes signed-out viewers", async () => {
  await P.save(admin, { cfg: { mode: "staff" } });
  assert.deepEqual([null, member, staff, admin].map(P.viewerOn), [false, false, true, true]);
  const original = SP.can;
  try {
    const calls = []; SP.can = (user, capability) => { calls.push(capability); return user === member; };
    assert.equal(P.viewerOn(member), true); assert.equal(P.viewerOn(admin), false);
    assert.deepEqual(calls, ["pads.manage_any", "pads.manage_any"]);
  } finally { SP.can = original; }
  await P.save(admin, { cfg: { mode: "everyone" } });
  for (const user of [null, member, staff, admin]) assert.equal(P.viewerOn(user), true);
  await P.save(admin, { cfg: { mode: "off" } });
  for (const user of [null, member, staff, admin]) assert.equal(P.viewerOn(user), false);
});

test("admin route requires pads.config and same-site fetch; refused requests do not change config", async () => {
  const prior = P.current();
  assert.equal((await request("GET", null, null)).status, 401);
  for (const user of ["member", "staff"]) {
    assert.equal((await request("GET", null, user)).status, 403);
    assert.equal((await post({ cfg: { mode: "everyone" } }, user)).status, 403);
  }
  assert.equal((await post({ cfg: { mode: "everyone" } }, "admin", {})).status, 403);
  assert.equal((await post({ cfg: { mode: "everyone" } }, "admin", { "X-Requested-With": "fetch", Origin: "https://foreign.invalid" })).status, 403);
  assert.deepEqual(P.current(), prior);
  const result = await post({ cfg: { mode: "staff" }, reason: "Staging review" });
  assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.data.cfg.mode, "staff");
  assert.equal(result.data.view.audit[0].reason, "Staging review");
  assert.deepEqual(result.data.view.audit[0].detail.changed.mode, ["off", "staff"]);
  assert.equal((await request("GET")).headers.get("cache-control"), "no-store");
});

test("every accepted save is versioned and audited; concurrent saves serialize and persisted state reloads", async () => {
  const prior = P.current().v;
  const results = await Promise.all([P.save(admin, { cfg: { mode: "everyone" } }), P.save(admin, { cfg: { mode: "staff" } })]);
  assert.deepEqual(results.map(x => x.v), [prior + 1, prior + 2]);
  assert.deepEqual(results[1].changed.mode, ["everyone", "staff"]);
  const audit = await db.getQuery("SELECT * FROM admin_audit WHERE action='paddock_cfg' ORDER BY id");
  assert.equal(audit.length, P.current().v); assert.equal(audit.at(-1).admin_id, "admin");
  const saved = P.current(); saved.cfg.mode = "tamper"; assert.equal(P.current().cfg.mode, "staff");
  const original = P.current(); P._reset(); await P.init(); assert.deepEqual(P.current(), original);
  const reset = await P.save(admin, { reset: true, cfg: { mode: "invalid" } });
  assert.equal(reset.cfg.mode, "off");
  const row = (await P.view()).audit[0]; assert.equal(row.detail.action, "reset");
});

test("save rate limit is per admin and leaves the last accepted state unchanged", async () => {
  P._reset(); await P.init();
  for (let i = 0; i < 20; i++) assert.equal((await post({ cfg: { mode: i % 2 ? "staff" : "off" } })).status, 200);
  const before = P.current(); assert.equal((await post({ cfg: { mode: "everyone" } })).status, 429);
  assert.deepEqual(P.current(), before);
  assert.equal((await P.save({ ...admin, userId: "other-admin" }, { cfg: { mode: "off" } })).cfg.mode, "off");
});

test("an audit failure rolls back the saved row and leaves the per-process audience unchanged", async () => {
  const audit = require(path.join(repo, "adminaudit")), original = audit.record, prior = P.current();
  const row = await db.getQuery("SELECT * FROM paddock_cfg");
  try {
    audit.record = async () => { throw new Error("fixture audit unavailable"); };
    await assert.rejects(P.save({ ...admin, userId: "audit-admin" }, { cfg: { mode: "everyone" } }), /audit unavailable/);
    assert.deepEqual(P.current(), prior); assert.deepEqual(await db.getQuery("SELECT * FROM paddock_cfg"), row);
  } finally { audit.record = original; }
});

// A minimal event-capable DOM. The widgets remain the real room-bridge.js implementation.
function browser(options = {}) {
  let now = 1000, timer = 0, tracksStopped = 0;
  const timers = new Map(), requests = [], stored = new Map(), records = [], sessions = [];
  function events(object) {
    object.listeners = {};
    object.addEventListener = (key, fn, capture = false) => { (object.listeners[key] ||= []).push({ fn, capture }); };
    object.removeEventListener = (key, fn, capture = false) => { object.listeners[key] = (object.listeners[key] || []).filter(x => x.fn !== fn || x.capture !== capture); };
    object.fire = (key, e = {}) => {
      const entries = (object.listeners[key] || []).slice();
      entries.filter(x => x.capture).concat(entries.filter(x => !x.capture)).forEach(entry => {
        if ((object.listeners[key] || []).includes(entry)) entry.fn({ type: key, preventDefault() {}, ...e });
      });
    };
    object.dispatchEvent = e => { object.fire(e.type, e); return true; };
    return object;
  }
  function makeDoc() {
    const doc = events({ hidden: false, defaultView: events({}) });
    doc.createElement = tag => element(tag, doc); doc.createTextNode = text => Object.assign(element("#text", doc), { textContent: text });
    return doc;
  }
  function element(tag, doc) {
    const classes = new Set(); let own = "";
    const e = events({ tagName: tag, ownerDocument: doc, children: [], parentNode: null, attrs: {}, style: {}, value: "", selectionStart: 0, selectionEnd: 0, volume: 1, muted: false, paused: true,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter(x => x !== child); child.parentNode = null; },
      focus() { this.focused = true; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      querySelectorAll(selector) { const all = this.children.flatMap(c => [c, ...c.querySelectorAll(selector)]); return all.filter(c => selector[0] === "." ? c.classList.contains(selector.slice(1)) : c.tagName === selector); },
      play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, load() {} });
    e.classList = { add: (...v) => v.forEach(x => classes.add(x)), remove: (...v) => v.forEach(x => classes.delete(x)), contains: x => classes.has(x), toggle(x, force) { const on = force === undefined ? !classes.has(x) : !!force; if (on) classes.add(x); else classes.delete(x); return on; } };
    Object.defineProperties(e, {
      className: { get: () => [...classes].join(" "), set: v => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(x => classes.add(x)); } },
      textContent: { get: () => own + e.children.map(c => c.textContent).join(""), set: v => { own = String(v); e.children.forEach(c => { c.parentNode = null; }); e.children = []; } },
      options: { get: () => e.children }, firstChild: { get: () => e.children[0] || null }
    }); return e;
  }
  const doc = makeDoc(), win = events({}); doc.defaultView = win;
  class Recorder {
    constructor(stream) { this.stream = stream; this.state = "inactive"; this.mimeType = "audio/webm"; records.push(this); }
    static isTypeSupported(t) { return t === "audio/webm"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; if (this.onstop) this.onstop(); }
  }
  const stream = { getTracks: () => [{ stop() { tracksStopped++; } }] };
  Object.assign(win, { MediaRecorder: Recorder });
  const ctx = { window: win, document: doc, console, navigator: { userAgent: options.ios ? "iPhone" : "Chrome", platform: options.ios ? "iPhone" : "Win32", mediaDevices: { getUserMedia: options.gum || (() => Promise.resolve(stream)) }, audioSession: { set type(v) { sessions.push(v); } } },
    localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)) },
    setTimeout: (fn, ms) => { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    fetch: (url, init) => { requests.push({ url, init }); return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }); },
    Blob: class { constructor(parts, cfg) { this.type = cfg.type; } }, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } }, MediaRecorder: Recorder, Date: { now: () => now } };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8"), ctx);
  return { api: win.PATVRoom, doc, win, makeDoc, host: () => element("div", doc), requests, stored, timers, records, sessions, stream,
    advance: ms => { now += ms; }, stopped: () => tracksStopped, flush: async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); } };
}

test("relay insertion uses the existing input, selection and limit; command hook uses the existing authenticated endpoint", async () => {
  const b = browser(), host = b.host(), relay = b.api.relay(host, "fixture-room");
  relay.update({ room: { relay: true, cmds: { "!say": 100 } }, mine: [] });
  const input = relay.getInput(); assert.equal(input, host.querySelector("input"));
  relay.insert("hello room"); input.setSelectionRange(6, 10); relay.insert("crew"); assert.equal(input.value, "hello crew");
  relay.insert("x".repeat(299), { replace: true });
  assert.equal(relay.insert("🐸"), ""); assert.equal(input.value.length, 299, "never inserts half a surrogate pair");
  relay.insert("!"); assert.equal(input.value.length, 300); assert.equal(host.querySelector(".rb-count").textContent, "0 left");
  assert.equal(relay.insert("overflow"), ""); assert.equal(b.requests.length, 0, "inserting a tool command never spends PAT");
  relay.sendCmd("!say hello crew"); await b.flush();
  assert.equal(b.requests.length, 1); assert.equal(b.requests[0].url, "/api/rooms/fixture-room/say");
  assert.equal(b.requests[0].init.credentials, "same-origin"); assert.equal(b.requests[0].init.headers["X-Requested-With"], "fetch");
  assert.deepEqual(JSON.parse(b.requests[0].init.body), { text: "!say hello crew" });
});

test("ducking is off by default, affects both media elements only during recording, and preserves mute and selected volume", () => {
  const b = browser(), host = b.host(), audio = b.api.audio(host, "fixture-room"), media = host.querySelectorAll("audio");
  const volume = host.querySelector(".rb-vol"), mute = host.querySelector(".rb-mute");
  assert.equal(audio.duck(), false); audio.setRecording(true); media.forEach(m => assert.equal(m.volume, .8));
  audio.duck(true); media.forEach(m => assert.ok(Math.abs(m.volume - .16) < 1e-9));
  volume.value = "50"; volume.fire("input"); media.forEach(m => assert.equal(m.volume, .1));
  assert.equal(b.stored.get("patvRoomVol"), "50");
  mute.fire("click"); media.forEach(m => assert.equal(m.muted, true));
  audio.setRecording(false); media.forEach(m => { assert.equal(m.volume, .5); assert.equal(m.muted, true); });
  assert.equal(b.stored.get("patvRoomVol"), "50"); assert.equal(b.stored.get("patvRoomMuted"), "1");
  audio.setRecording(true); audio.duck(false); media.forEach(m => assert.equal(m.volume, .5));
  const i = browser({ ios: true }), ih = i.host(), ia = i.api.audio(ih, "fixture-room"); ia.duck(true); ia.setRecording(true);
  ih.querySelectorAll("audio").forEach(m => assert.equal(m.volume, 1, "iOS hardware-volume path remains untouched"));
});

test("PTT moves to its owner document: old visibility no longer stops it, new hide/pagehide does, and recording callbacks restore audio", async () => {
  const b = browser(), host = b.host(), player = b.api.audio(b.host(), "fixture-room"), ptt = b.api.ptt(host, "fixture-room"), seen = [];
  const unsub = ptt.onRecording(on => { seen.push(on); player.setRecording(on); });
  ptt.update({ room: { micRelay: true }, mine: [] });
  const button = host.querySelector(".rb-talk"), pip = b.makeDoc();
  host.ownerDocument = pip; host.fire("patv:surfacechange");
  assert.equal(b.doc.listeners.visibilitychange.length, 0); assert.equal(pip.listeners.visibilitychange.length, 1);
  button.fire("pointerdown"); await b.flush(); assert.equal(b.records[0].state, "recording");
  b.doc.hidden = true; b.doc.fire("visibilitychange"); assert.equal(b.records[0].state, "recording");
  b.advance(1000); pip.hidden = true; pip.fire("visibilitychange");
  assert.equal(b.records[0].state, "inactive"); assert.equal(b.stopped(), 1); assert.deepEqual(seen, [false, true, false]);
  pip.hidden = false; button.fire("pointerdown"); await b.flush(); b.advance(1000); pip.defaultView.fire("pagehide");
  assert.equal(b.records[1].state, "inactive"); assert.equal(b.stopped(), 2);
  host.ownerDocument = b.doc; b.doc.hidden = false; ptt.adopt(b.doc); assert.equal(pip.listeners.visibilitychange.length, 0);
  unsub(); button.fire("pointerdown"); await b.flush(); ptt.update({ room: { micRelay: false }, mine: [] });
  assert.equal(b.stopped(), 3); assert.deepEqual(seen, [false, true, false, true, false], "unsubscribe removes only this listener");
});

test("an async mic grant after the moved document hides releases all tracks without starting a recorder", async () => {
  let grant; const b = browser({ gum: () => new Promise(resolve => { grant = resolve; }) });
  const host = b.host(), ptt = b.api.ptt(host, "fixture-room"), pip = b.makeDoc(), seen = [];
  ptt.onRecording(on => seen.push(on)); ptt.update({ room: { micRelay: true }, mine: [] });
  host.ownerDocument = pip; ptt.adopt(pip); host.querySelector(".rb-talk").fire("pointerdown");
  pip.hidden = true; grant(b.stream); await b.flush();
  assert.equal(b.records.length, 0); assert.equal(b.stopped(), 1); assert.deepEqual(seen, [false]);
});

test("PTT marks only the idle helper as quiet; opening, recording and permission errors retain their status text", async () => {
  let grant; const b = browser({ gum: () => new Promise(resolve => { grant = resolve; }) });
  const host = b.host(), ptt = b.api.ptt(host, "fixture-room"); ptt.update({ room: { micRelay: true }, mine: [] });
  const status = host.querySelector(".rb-ptt-txt"), button = host.querySelector(".rb-talk");
  assert.equal(status.classList.contains("rb-ptt-idle"), true);
  button.fire("pointerdown"); assert.equal(status.classList.contains("rb-ptt-idle"), false); assert.match(status.textContent, /opening/);
  b.doc.hidden = true; grant(b.stream); await b.flush(); assert.equal(status.classList.contains("rb-ptt-idle"), true); assert.match(status.textContent, /up to 20 s/);
  b.doc.hidden = false; button.fire("pointerdown"); grant(b.stream); await b.flush();
  assert.equal(status.classList.contains("rb-ptt-idle"), false); assert.equal(status.textContent, "recording…");
  b.advance(1000); button.fire("pointerup"); await b.flush(); assert.equal(status.classList.contains("rb-ptt-idle"), false); assert.match(status.textContent, /sent/);
  const refused = browser({ gum: () => Promise.reject(new Error("fixture permission denied")) }), rh = refused.host();
  refused.api.ptt(rh, "fixture-room").update({ room: { micRelay: true }, mine: [] }); rh.querySelector(".rb-talk").fire("pointerdown"); await refused.flush();
  assert.equal(rh.querySelector(".rb-ptt-txt").classList.contains("rb-ptt-idle"), false); assert.match(rh.querySelector(".rb-ptt-txt").textContent, /didn.t allow/);
});

test("closing PiP stops recording before its earlier-registered redock handler removes PTT listeners", async () => {
  const b = browser(), host = b.host(), ptt = b.api.ptt(host, "fixture-room"), pip = b.makeDoc();
  ptt.update({ room: { micRelay: true }, mine: [] });
  pip.defaultView.addEventListener("pagehide", () => { host.ownerDocument = b.doc; ptt.adopt(b.doc); });
  host.ownerDocument = pip; ptt.adopt(pip);
  host.querySelector(".rb-talk").fire("pointerdown"); await b.flush();
  assert.equal(b.records[0].state, "recording"); b.advance(1000); pip.defaultView.fire("pagehide");
  assert.equal(host.ownerDocument, b.doc); assert.equal(b.records[0].state, "inactive"); assert.equal(b.stopped(), 1);
});

test("a mic grant arriving after PiP closes cannot begin recording in the redocked visible page", async () => {
  let grant; const b = browser({ gum: () => new Promise(resolve => { grant = resolve; }) });
  const host = b.host(), ptt = b.api.ptt(host, "fixture-room"), pip = b.makeDoc();
  ptt.update({ room: { micRelay: true }, mine: [] });
  pip.defaultView.addEventListener("pagehide", () => { host.ownerDocument = b.doc; ptt.adopt(b.doc); });
  host.ownerDocument = pip; ptt.adopt(pip); host.querySelector(".rb-talk").fire("pointerdown");
  pip.defaultView.fire("pagehide"); grant(b.stream); await b.flush();
  assert.equal(b.records.length, 0); assert.equal(b.stopped(), 1); assert.equal(b.sessions.at(-1), "auto");
});

test("admin script loads once, saves the chosen mode, resets explicitly, and shows a refused save without pretending success", async () => {
  const b = browser(), ids = {}, calls = [], doc = b.doc;
  for (const id of ["paddockForm", "paddockFields", "paddockMessage", "paddockAudit", "paddockReset"]) ids[id] = doc.createElement(id === "paddockForm" ? "form" : id === "paddockReset" ? "button" : "div");
  doc.getElementById = id => ids[id] || null;
  const form = ids.paddockForm, reason = doc.createElement("input"), save = doc.createElement("button"); reason.name = "reason";
  form.appendChild(ids.paddockFields); form.appendChild(reason); form.appendChild(ids.paddockReset); form.appendChild(save);
  Object.defineProperty(form, "elements", { get: () => Object.fromEntries([...form.querySelectorAll("input"), ...form.querySelectorAll("select")].map(n => [n.name, n])) });
  let mode = "off", failure = null;
  const view = () => ({ cfg: { mode }, fields: P.FIELDS, audit: [{ at: 1, admin: "<script>fixture</script>", detail: { v: 1 } }] });
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public/js/admin-paddock.js"), "utf8"), {
    window: {}, document: doc, fetch: async (url, init) => {
      calls.push({ url, init });
      if (init.method) {
        if (failure) return { json: async () => ({ ok: false, error: failure }) };
        const body = JSON.parse(init.body); mode = body.reset ? "off" : body.cfg.mode;
        return { json: async () => ({ ok: true, view: view() }) };
      }
      return { json: async () => ({ ok: true, ...view() }) };
    }
  });
  await b.flush(); assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/admin/paddock"); assert.equal(form.elements.mode.value, "off");
  assert.match(ids.paddockAudit.textContent, /<script>fixture<\/script>/, "audit names stay literal text");
  form.elements.mode.value = "staff"; reason.value = " Staging review "; form.fire("submit"); await b.flush();
  assert.equal(calls[1].init.method, "POST"); assert.equal(calls[1].init.headers["X-Requested-With"], "fetch");
  assert.deepEqual(JSON.parse(calls[1].init.body), { cfg: { mode: "staff" }, reset: false, reason: "Staging review" });
  assert.equal(form.elements.mode.value, "staff"); assert.equal(reason.value, ""); assert.match(ids.paddockMessage.textContent, /Saved.*Reload/);
  ids.paddockReset.fire("click"); await b.flush(); assert.equal(form.elements.mode.value, "off"); assert.equal(JSON.parse(calls[2].init.body).reset, true);
  failure = "rate"; form.elements.mode.value = "everyone"; form.fire("submit"); await b.flush();
  assert.match(ids.paddockMessage.textContent, /Wait a moment/); assert.equal(mode, "off"); assert.equal(save.disabled, false);
});
