// Offline A/V sync server contract: dark rollout, audited settings, exact-chunk metadata and viewer-private cam timing.
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const repo = path.resolve(__dirname, ".."), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avsync-test-"));
process.chdir(tmp); process.env.SECRET_KEY = "test-secret"; delete process.env.STAGING;
const express = require("express"), db = require(path.join(repo, "dbUtils"));
const AV = require(path.join(repo, "avsync")), LC = require(path.join(repo, "livecam"));
const PA = require(path.join(repo, "padaccess")), B = require(path.join(repo, "bridge")), AC = require(path.join(repo, "roomaudiocfg"));
const W = require(path.join(repo, "webrtc")); W.enabled = () => true;
let time = Date.now(), base, server, cam, otherCam, app;
const writes = [];
AV._setClock(() => time); LC._setClock(() => time);
const ADMIN = { userId: "adm", username: "admin-example", class: "Admin" };
const ROOM = "Example.Alpha", OTHER = "Example.Beta", LOCKED = "Example.Locked";
function room(id, name) { return { room: { id, name }, topic: "", members: [{ login: "frog-example", display: "Example frog", on_cam: true }], count: 1, audio: true, audio_on: true, livecams: true, cams: true }; }
async function request(method, route, body, user = "v1", extra = {}) {
  const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...extra }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) };
}
const post = (route, body, user, headers) => request("POST", route, body, user, headers);
const bot = (route, body) => post(route, { password: "bot-test", ...body }, null);
const get = (route, user) => request("GET", route, null, user);
const adminSave = (cfg) => post("/api/admin/pepe/avsync", { cfg }, "adm", { "X-Requested-With": "fetch" });
const publicPath = (paths) => "/api/rooms/alpha/avsync" + (paths ? "?p=" + encodeURIComponent(paths) : "");

test.before(async () => {
  await db.runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
    class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  await db.runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const id of ["adm", "v1", "v2", "limit"]) await db.runQuery("INSERT OR IGNORE INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, id, id === "adm" ? "Admin" : "pleb", id + "-frog"]);
  await require(path.join(repo, "mainstage")).init(); await PA.init(); await AV.init(); await AC.init(); await LC.init();
  await LC.save(ADMIN, { cfg: { enabled: true, viewers_free: 4 } });
  app = express(); app.use(express.json()); app.set("views", path.join(repo, "views")); app.set("view engine", "ejs");
  app.use((req, res, next) => { const id = req.get("x-test-user"); req.user = id ? { userId: id, username: id, class: id === "adm" ? "Admin" : "pleb" } : null; next(); });
  app.use((req, res, next) => {
    if (req.path === "/p/alpha/audio") {
      const write = res.write;
      res.write = function (chunk) { writes.push({ chunk: Buffer.from(chunk), meta: AV.audioMeta(ROOM) }); return write.apply(this, arguments); };
    }
    next();
  });
  const deps = { addUser: (req, res, next) => next(), isBotToken: (value) => value === "bot-test" };
  B.register(app, deps); AC.register(app, deps); AV.register(app, deps);
  server = app.listen(0); base = "http://127.0.0.1:" + server.address().port;
  await bot("/api/bridge/sync", { events: [], rooms: [room(ROOM, "Alpha"), room(OTHER, "Beta"), room(LOCKED, "Locked")] });
  await db.runQuery("INSERT INTO pad_access (room_id, level) VALUES (?, 'approved')", [LOCKED]); await PA.load();
  await bot("/api/bridge/livecam", { cap: true });
  const ticket = await post("/api/rooms/alpha/livecam", { login: "frog-example" }, "v1", { "X-Requested-With": "fetch" });
  assert.equal(ticket.data.ok, true, JSON.stringify(ticket)); cam = new URL(ticket.data.whep).pathname.split("/").pop();
  const other = await post("/api/rooms/beta/livecam", { login: "frog-example" }, "v1", { "X-Requested-With": "fetch" });
  assert.equal(other.data.ok, true, JSON.stringify(other)); otherCam = new URL(other.data.whep).pathname.split("/").pop();
  await bot("/api/bridge/livecam", { cap: true, live: [
    { room: ROOM, login: "frog-example", state: "live", source: "passthrough", hold_ms: 170.7, exact: true },
    { room: OTHER, login: "frog-example", state: "live", source: "reencode", hold_ms: 75, exact: true }
  ] });
});
test.after(() => { server.close(); });

test("dark defaults, all settings ranges and strict booleans; persisted settings reload", async () => {
  assert.equal(AV.current().v, 0); assert.equal(AV.DEFAULTS.mode, "off");
  assert.deepEqual([AV.DEFAULTS.engine_chromium, AV.DEFAULTS.engine_firefox, AV.DEFAULTS.engine_safari, AV.DEFAULTS.mods_instant], [true, false, false, false]);
  assert.deepEqual([AV.DEFAULTS.fallback_rtc_ms, AV.DEFAULTS.fallback_mp3_ms, AV.DEFAULTS.cap_ms, AV.DEFAULTS.cap_ind_ms, AV.DEFAULTS.period_s], [500, 1500, 3000, 3000, 2]);
  for (const [key, field] of Object.entries(AV.FIELDS)) {
    if (field.min == null) continue;
    assert.ok(AV.normalize({ [key]: field.min - 1 }).errors[key]);
    assert.ok(AV.normalize({ [key]: field.max + 1 }).errors[key]);
    assert.equal(AV.normalize({ [key]: field.min }).cfg[key], field.min);
    assert.equal(AV.normalize({ [key]: field.max }).cfg[key], field.max);
  }
  assert.ok(AV.normalize({ mode: "all" }).errors.mode); assert.ok(AV.normalize({ apply_video: "yes" }).errors.apply_video);
  assert.ok(AV.normalize({ cap_ms: true }).errors.cap_ms);
  assert.equal(AV.normalize({ cap_ms: 9000 }, { lenient: true }).cfg.cap_ms, 4000);
  assert.equal(AV.normalize({ apply_video: "false" }).cfg.apply_video, false);
  assert.equal(AV.normalize({ k_pt_ms: "-25" }).cfg.k_pt_ms, -25);
});

test("admin capability + same-site fetch, every save versioned and audited, invalid values atomic", async () => {
  assert.equal((await get("/api/admin/pepe/avsync", null)).status, 401);
  assert.equal((await get("/api/admin/pepe/avsync", "v1")).status, 403);
  assert.equal((await post("/api/admin/pepe/avsync", { cfg: { mode: "everyone" } }, "adm")).status, 403);
  assert.equal((await post("/api/admin/pepe/avsync", { cfg: { mode: "everyone" } }, "adm", { "X-Requested-With": "fetch", origin: "https://foreign.invalid" })).status, 403);
  const first = await adminSave({ mode: "admins", k_pt_ms: -100 }); assert.equal(first.status, 200); assert.equal(first.data.v, 1);
  const second = await adminSave({ mode: "admins" }); assert.equal(second.data.v, 2, "every accepted save gets an audit and version");
  const invalid = await adminSave({ cap_ms: 4001, apply_video: false }); assert.equal(invalid.status, 400); assert.equal(AV.current().v, 2); assert.equal(AV.current().cfg.apply_video, true);
  const audit = await db.getQuery("SELECT * FROM admin_audit WHERE action = 'avsync_cfg' ORDER BY id");
  assert.equal(audit.length, 2); assert.equal(JSON.parse(audit[0].detail).changed.mode[1], "admins");
  assert.equal(audit[0].admin_id, "adm");
  const prior = AV.current(); AV._reset(); await AV.init(); assert.deepEqual(AV.current(), prior, "versioned database row survives process cache reset");
  const page = await fetch(base + "/admin/pepe/audio", { headers: { "x-test-user": "adm" } });
  const html = await page.text(); assert.equal(page.status, 200); assert.match(html, /id="av-sync"/); assert.match(html, /admin-avsync\.js\?v=4/);   // 1.99ahm: 3 - Delay the people list's 🎙 icons; 1.99ait avf: 4 - the mic-sign fallbacks, mic_follow_toggle
});

test("public route requires sign-in/full pad access; mode does not grant access; no identifiers or unheld cams", async () => {
  assert.equal((await get(publicPath(), null)).status, 401);
  assert.equal((await get("/api/rooms/locked/avsync", "v1")).status, 403);
  assert.equal((await get("/api/rooms/not-there/avsync", "v1")).status, 404);
  const viewer = await get(publicPath(cam + "," + otherCam + ",room-ffffffffffffffff"), "v1");
  assert.equal(viewer.data.on, false); assert.equal(viewer.data.dbg, false); assert.equal(viewer.headers.get("cache-control"), "no-store");
  assert.deepEqual(viewer.data.cams, { [cam]: { src: "passthrough", hold_ms: 171 } });
  assert.equal((await get(publicPath(cam), "adm")).data.on, true);
  assert.deepEqual((await get(publicPath(cam), "v2")).data.cams, {});
  const text = JSON.stringify(viewer.data); for (const privateValue of [ROOM, OTHER, "frog-example", "Example frog", "v1", "login", "room_id", "username"]) assert.ok(!text.includes(privateValue), privateValue);
  await adminSave({ mode: "everyone" }); assert.equal((await get(publicPath(), "v1")).data.on, true);
  await adminSave({ mode: "off" }); assert.equal((await get(publicPath(), "adm")).data.on, false);
  assert.equal((await get(publicPath(Array(13).fill(cam).join(",")), "v1")).status, 400);
});

test("review fix: the pad page loads av-sync.js only while the mode applies to the viewer, so a dark rollout never polls", async () => {
  const mode = AV.current().cfg.mode;
  app.locals.webrtcCfg = () => ({ base: "https://relay.example.invalid", turn: "/api/turn" });
  const page = async (user) => {
    const r = await fetch(base + "/p/alpha", { headers: user ? { "x-test-user": user } : {} });
    const html = await r.text(); assert.equal(r.status, 200, html.slice(0, 300));
    assert.match(html, /webrtc-client\.js\?v=6/, "the WebRTC block itself renders");
    return /av-sync\.js/.test(html);
  };
  try {
    await AV.save(ADMIN, { cfg: { mode: "off" } });
    for (const u of [null, "v1", "adm"]) { assert.equal(AV.viewerOn(u && { userId: u, class: u === "adm" ? "Admin" : "pleb" }), false); assert.equal(await page(u), false, "off: " + u); }
    await AV.save(ADMIN, { cfg: { mode: "admins" } });
    assert.deepEqual([await page(null), await page("v1"), await page("adm")], [false, false, true], "admins: only the capability");
    await AV.save(ADMIN, { cfg: { mode: "everyone" } });
    assert.deepEqual([await page(null), await page("v1"), await page("adm")], [false, true, true], "everyone: signed in (its route answers 401 otherwise)");
    assert.equal(AV.viewerOn({ username: "no-id" }), false);
    const admin = await (await fetch(base + "/admin/pepe/audio", { headers: { "x-test-user": "adm" } })).text();
    assert.match(admin, /picks up a change of who gets sync when it loads: reload a pad that is already open/, "the admin card says so");
  } finally { delete app.locals.webrtcCfg; await AV.save(ADMIN, { cfg: { mode } }); }
});

test("slot holds reject other viewers, wrong pads, expired beats, removed holds and ended sessions", () => {
  const session = LC.camForPath(cam), viewer = session.viewers.get("v1"), beat = viewer.beat;
  assert.deepEqual(LC.holdOf(cam, "v1"), { src: "passthrough", hold_ms: 171 });
  assert.equal(LC.holdOf(cam, "v1", OTHER), null); assert.equal(LC.holdOf(cam, "v2"), null);
  viewer.beat = time - LC.BEAT_MS - 1; assert.equal(LC.holdOf(cam, "v1"), null); viewer.beat = beat;
  session.stageViewers.set("v2", { beat: time }); assert.equal(LC.holdOf(cam, "v2"), null);
  session.holds.add("test-stage"); assert.deepEqual(LC.holdOf(cam, "v2"), LC.relayHold(cam));
  session.stageViewers.get("v2").beat -= LC.BEAT_MS + 1; assert.equal(LC.holdOf(cam, "v2"), null);
  session.stageViewers.delete("v2"); session.holds.delete("test-stage");
  session.ended = time; assert.equal(LC.holdOf(cam, "v1"), null); assert.equal(LC.relayHold(cam), null); session.ended = 0;
});

test("audio posts keep a synchronous exact-chunk metadata snapshot; old posts never claim hm=0", async () => {
  const before = time, chunk = Buffer.from("mock MP3 chunk");
  const sent = { room: ROOM, seq: 1, data: chunk.toString("base64"), lat: { mix_ms: 710.4, helper_ms: 740, rtc_ms: 1480, mp3_ms: 980, login: "must disappear" }, hm: 1 };
  const controller = new AbortController();
  try {
    const stream = await fetch(base + "/p/alpha/audio", { signal: controller.signal, headers: { "x-test-user": "v1" } });
    assert.equal(stream.status, 200);
    assert.equal((await bot("/api/bridge/audio", sent)).status, 200);
    const expected = { lat: { mix_ms: 710, helper_ms: 740, rtc_ms: 1480, mp3_ms: 980 }, hm: 1, at: before };
    assert.deepEqual(AV.audioMeta(ROOM), expected);
    assert.deepEqual(writes, [{ chunk, meta: expected }], "the synchronous reader sees this chunk's metadata inside the listener write");
  } finally { controller.abort(); }
  const copy = AV.audioMeta(ROOM); copy.lat.mix_ms = 0; copy.hm = 0; assert.equal(AV.audioMeta(ROOM).hm, 1); assert.equal(AV.audioMeta(ROOM).lat.mix_ms, 710);
  await bot("/api/bridge/audio", { room: ROOM, seq: 2, data: "" }); assert.equal(AV.audioMeta(ROOM).hm, null); assert.equal(AV.audioMeta(ROOM).lat.rtc_ms, null);
  AV.noteAudio(ROOM, { lat: { mix_ms: -5, helper_ms: 500000, rtc_ms: true, mp3_ms: "55", extra: 999 }, hm: "0" });
  assert.deepEqual(AV.audioMeta(ROOM).lat, { mix_ms: 0, helper_ms: 30000, rtc_ms: null, mp3_ms: null }); assert.equal(AV.audioMeta(ROOM).hm, null);
  assert.equal(AV.audioMeta("missing"), null);
  assert.deepEqual(AC.cleanState({ rooms: { [ROOM]: { lat: sent.lat } } }).rooms[ROOM].lat, { mix_ms: 710, helper_ms: 740, rtc_ms: 1480, mp3_ms: 980 });
});

test("per-room two-second cache never caches viewer holds or rollout permission; age still advances", async () => {
  time += 2100; AV.noteAudio(ROOM, { lat: { rtc_ms: 1200 }, hm: 0 });
  const a = await get(publicPath(cam), "v1"); assert.equal(a.data.audio.rtc_ms, 1200); assert.equal(a.data.audio.age_s, 0);
  time += 500; AV.noteAudio(ROOM, { lat: { rtc_ms: 1500 }, hm: 1 });
  const b = await get(publicPath(cam), "v2"); assert.equal(b.data.audio.rtc_ms, 1200); assert.equal(b.data.audio.age_s, 0.5); assert.deepEqual(b.data.cams, {});
  await adminSave({ mode: "everyone" }); assert.equal((await get(publicPath(), "v1")).data.on, true, "mode is not cached");
  time += 1600; const c = await get(publicPath(), "v1"); assert.equal(c.data.audio.rtc_ms, 1500); assert.equal(c.data.audio.age_s, 1.6);
});

test("server offset has no browser/viewer terms, uses relay source calibration, rejects unknown/stale/wrong-room inputs", async () => {
  await adminSave({ k_pt_ms: -80, k_re_ms: 50 });
  AV.noteAudio(ROOM, { lat: { rtc_ms: 1500, mp3_ms: 900 }, hm: 0 }); AV.noteAudio(OTHER, { lat: { rtc_ms: 1200, mp3_ms: 800 }, hm: 0 });
  assert.equal(AV.serverOffsetMs(ROOM, cam, "rtc"), 1249); assert.equal(AV.serverOffsetMs(ROOM, cam, "mp3"), 649);
  assert.equal(AV.serverOffsetMs(OTHER, otherCam, "rtc"), 1175);
  assert.equal(AV.serverOffsetMs(ROOM, otherCam, "rtc"), null); assert.equal(AV.serverOffsetMs(ROOM, cam, "hls"), null);
  const slot = LC.camForPath(cam).viewers.get("v1"); slot.beat = time - LC.BEAT_MS - 1;
  assert.equal(LC.holdOf(cam, "v1"), null); assert.equal(AV.serverOffsetMs(ROOM, cam, "rtc"), 1249, "server clip calculation has no viewer dependency"); slot.beat = time;
  time += 30001; assert.equal(AV.serverOffsetMs(ROOM, cam, "rtc"), null);
});

test("admin diagnostics expose cleaned parts; public request rate is bounded", async () => {
  const admin = await get("/api/admin/pepe/avsync", "adm"); assert.equal(admin.status, 200);
  assert.ok(admin.data.rooms.some((row) => row.room === ROOM && Object.keys(row.lat).length === 4));
  assert.ok(admin.data.relays.some((row) => row.path === cam && row.hold_ms === 171));
  let last; for (let i = 0; i < 31; i++) last = await get(publicPath(), "limit");
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get("retry-after")) > 0);
});

test("relay reports clamp finite numeric holds and keep absent/invalid holds unknown", async () => {
  for (const [raw, expected] of [[-1, 0], [1.5, 2], [10001, 10000], ["100", null], [true, null], [null, null], [undefined, null]]) {
    await bot("/api/bridge/livecam", { cap: true, live: [{ room: ROOM, login: "frog-example", state: "live", source: "passthrough", hold_ms: raw, exact: true }] });
    assert.deepEqual(LC.relayHold(cam), { src: "passthrough", hold_ms: expected });
  }
});

test("queued partial saves preserve both changes; reset restores dark defaults and is audited", async () => {
  const before = AV.current().v;
  const saved = await Promise.all([AV.save(ADMIN, { cfg: { k_pt_ms: 125 } }), AV.save(ADMIN, { cfg: { cap_ms: 2000 } })]);
  assert.deepEqual(saved.map((r) => r.v), [before + 1, before + 2]);
  assert.equal(AV.current().cfg.k_pt_ms, 125); assert.equal(AV.current().cfg.cap_ms, 2000);
  const reset = await post("/api/admin/pepe/avsync", { reset: true, reason: "test reset" }, "adm", { "X-Requested-With": "fetch" });
  assert.equal(reset.status, 200); assert.equal(reset.data.v, before + 3); assert.deepEqual(reset.data.cfg, AV.DEFAULTS);
  assert.equal(reset.data.view.audit[0].detail.action, "reset"); assert.equal(reset.data.view.audit[0].reason, "test reset");
});

// 1.99ahm: "Delay the On the mic card" (apply_mic_card) and "Delay mic grab/drop lines in chat" (apply_mic_chat)
test("1.99ahm: the card and chat-line switches - off by default, strict booleans, audited, in the viewer's answer; an older stored row reads them off", async () => {
  assert.equal(AV.DEFAULTS.apply_mic_card, false); assert.equal(AV.DEFAULTS.apply_mic_chat, false);
  assert.ok(AV.normalize({ apply_mic_card: "yes" }).errors.apply_mic_card); assert.ok(AV.normalize({ apply_mic_chat: 2 }).errors.apply_mic_chat);
  assert.equal(AV.normalize({ apply_mic_card: "true", apply_mic_chat: 1 }).cfg.apply_mic_card, true);
  assert.equal(AV.normalize({ apply_mic_chat: "1" }).cfg.apply_mic_chat, true);
  const bad = await adminSave({ mode: "everyone", apply_mic_card: "on" });
  assert.equal(bad.status, 400); assert.equal(bad.data.fields.apply_mic_card, "on or off"); assert.equal(AV.current().cfg.apply_mic_card, false, "nothing saved");
  const off = await get(publicPath(), "v1");
  assert.deepEqual([off.data.apply.mic_card, off.data.apply.mic_chat], [false, false]);
  const saved = await adminSave({ mode: "everyone", apply_mic_card: true });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.changed.apply_mic_card, [false, true]); assert.equal(saved.data.changed.apply_mic_chat, undefined);
  const audit = await db.getQuery("SELECT detail FROM admin_audit WHERE action = 'avsync_cfg' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(audit[0].detail).changed.apply_mic_card, [false, true], "audited like the others");
  const on = await get(publicPath(), "v1");
  assert.deepEqual(on.data.apply, { video: true, mic: true, mp3: true, mic_card: true, mic_chat: false, mic_list: false });   // (1.99ahm: + mic_list)
  await adminSave({ apply_mic_chat: true }); assert.equal((await get(publicPath(), "v2")).data.apply.mic_chat, true);
  // a row saved before these switches existed: both read off, everything else as it was
  await db.runQuery("UPDATE avsync_cfg SET data = ? WHERE id = 1", [JSON.stringify({ mode: "everyone", apply_mic: true, cap_ind_ms: 2500 })]);
  AV._reset(); await AV.init();
  assert.equal(AV.current().cfg.mode, "everyone"); assert.equal(AV.current().cfg.cap_ind_ms, 2500);
  assert.deepEqual([AV.current().cfg.apply_mic_card, AV.current().cfg.apply_mic_chat], [false, false]);
  const view = await get("/api/admin/pepe/avsync", "adm");
  const keys = Object.keys(view.data.fields);
  assert.deepEqual(keys.slice(keys.indexOf("apply_mic"), keys.indexOf("apply_mic") + 4), ["apply_mic", "apply_mic_card", "apply_mic_chat", "apply_mic_list"],
    "the card lists them under Delay mic signs (1.99ahm: + the people list's)");
  await AV.save(ADMIN, { reset: true });
});

// The admin card (public/js/admin-avsync.js) in a small fake DOM: the two switches with their labels and what each holds back
// (review fix C-1: the GETs answer viewData, then each of `later` in turn - a deploy while the page is open; poll() = the 5 s check)
function adminCard(viewData, ...later) {
  const src = fs.readFileSync(path.join(repo, "public", "js", "admin-avsync.js"), "utf8");
  const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const byId = {}, posts = [], views = [viewData, ...later]; let tick = null, gets = 0;
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.listeners = {}; this.text = ""; this.className = ""; }
    set textContent(v) { this.children = []; this.text = String(v); }
    get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
    fire(k, e = {}) { (this.listeners[k] || []).forEach((fn) => fn({ preventDefault() {}, ...e })); }
    all() { return this.children.flatMap((c) => (c instanceof El ? [c, ...c.all()] : [])); }
    querySelectorAll(sel) { return this.all().filter((n) => n.tagName === sel.toUpperCase()); }
  }
  const text = (t) => ({ textContent: String(t) });
  const form = new El("form"), reason = new El("input"); reason.name = "reason"; reason.value = ""; form.appendChild(reason);
  const fields = new El("div"); form.appendChild(fields); form.appendChild(new El("button"));
  Object.defineProperty(form, "elements", { get() { const out = {}; for (const n of form.all()) if (n.name) out[n.name] = n; return out; } });
  for (const id of ["avsMessage", "avsVersion", "avsRooms", "avsRelays", "avsAudit", "avsReset"]) byId[id] = new El("div");
  byId.avsForm = form; byId.avsFields = fields;
  const document = { getElementById: (id) => byId[id] || null, createElement: (t) => new El(t), createTextNode: text, hidden: false };
  const window = { __t: (k, d) => (k in EN ? EN[k] : "MISSING " + k), confirm: () => true };
  const fetch = (url, opts) => {
    const post = !!(opts && opts.body), v = post ? views.at(-1) : views[Math.min(gets++, views.length - 1)];
    if (post) posts.push(JSON.parse(opts.body));
    return Promise.resolve({ json: async () => ({ ok: true, v: 9, ...v, view: v }) });
  };
  const vm = require("node:vm");
  vm.runInNewContext(src, { window, document, fetch, setInterval: (fn) => { tick = fn; return 1; }, Date, JSON, Object, Array });
  return { form, fields, posts, EN, labelOf: (key) => fields.children.find((l) => l.children.some((c) => c.name === key)),
    poll: () => tick(), message: () => byId.avsMessage.textContent, views };
}

test("1.99ahm: the admin card lists the two switches with clear labels (locales/en.json) and says what each one holds back; a save sends them", async () => {
  const data = (await get("/api/admin/pepe/avsync", "adm")).data;
  const A = adminCard(data); for (let i = 0; i < 12; i++) await Promise.resolve();
  const card = A.labelOf("apply_mic_card"), chat = A.labelOf("apply_mic_chat"), mic = A.labelOf("apply_mic");
  assert.ok(card && chat && mic, "both switches are drawn");
  assert.equal(A.EN["js.admavsync.apply_mic_card"], "Delay the On the mic card");
  assert.equal(A.EN["js.admavsync.apply_mic_chat"], "Delay mic grab/drop lines in chat");
  assert.ok(card.textContent.includes(" Delay the On the mic card"), card.textContent);
  assert.ok(chat.textContent.includes(" Delay mic grab/drop lines in chat"), chat.textContent);
  assert.ok(card.textContent.includes(A.EN["js.admavsync.apply_mic_card_help"]) && /On the mic card beside the chat/.test(card.textContent));
  assert.ok(chat.textContent.includes(A.EN["js.admavsync.apply_mic_chat_help"]) && /Typed chat is never held/.test(chat.textContent));
  assert.ok(mic.textContent.includes(A.EN["js.admavsync.apply_mic_help"]) && /mic stage/.test(mic.textContent), "Delay mic signs says it is the mic stage's");
  assert.doesNotMatch(A.fields.textContent, /undefined|MISSING/);
  const box = (key) => A.labelOf(key).children.find((c) => c.name === key);
  assert.deepEqual([box("apply_mic_card").checked, box("apply_mic_chat").checked], [false, false], "off until an admin ticks them");
  box("apply_mic_chat").checked = true; A.form.fire("change"); A.form.fire("submit");
  assert.equal(A.posts.length, 1); assert.equal(A.posts[0].cfg.apply_mic_chat, true); assert.equal(A.posts[0].cfg.apply_mic_card, false);
});

test("1.99ahm: review fix (C-1) - an admin card left open across a deploy that changes the field list draws itself again; Save works and sends every field it shows", async () => {
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const data = (await get("/api/admin/pepe/avsync", "adm")).data;
  const older = JSON.parse(JSON.stringify(data));        // the site before a deploy that adds the mic switches (1.99ahm: three, with the people list's)
  for (const key of ["apply_mic_card", "apply_mic_chat", "apply_mic_list"]) { delete older.fields[key]; delete older.cfg[key]; delete older.defaults[key]; }
  // (1) the 5 s check brings the new list while the admin is changing a setting
  const A = adminCard(older, data); await flush();
  assert.equal(A.labelOf("apply_mic_card"), undefined, "drawn from the older site");
  const box = (C, key) => C.form.elements[key];
  box(A, "apply_video").checked = !box(A, "apply_video").checked; A.form.fire("change");
  const typed = box(A, "apply_video").checked;
  A.poll(); await flush();
  assert.ok(A.labelOf("apply_mic_card") && A.labelOf("apply_mic_chat") && A.labelOf("apply_mic_list"), "drawn again with the new switches");
  assert.equal(box(A, "apply_video").checked, typed, "what the admin was changing stays");
  assert.equal(box(A, "apply_mic_card").checked, false, "a new switch shows the site's value");
  box(A, "apply_mic_card").checked = true; A.form.fire("change"); A.form.fire("submit"); await flush();
  assert.equal(A.posts.length, 1, "Save posts");
  assert.deepEqual(Object.keys(A.posts[0].cfg).sort(), Object.keys(data.fields).sort(), "every field the card shows, no other");
  assert.equal(A.posts[0].cfg.apply_mic_card, true); assert.equal(A.posts[0].cfg.apply_video, typed);
  assert.match(A.message(), /^Saved as v\d+\./);
  // (2) a tab that slept through the deploy (no 5 s check): Save lands and the answer's new view is drawn - no "did not answer"
  const B = adminCard(older, data); await flush();
  box(B, "apply_mic").checked = false; B.form.fire("change"); B.form.fire("submit"); await flush();
  assert.equal(B.posts.length, 1); assert.match(B.message(), /^Saved as v\d+\./);
  assert.ok(B.labelOf("apply_mic_chat"), "the saved answer's field list is drawn");
  // (3) and back (a rollback): the fields the site no longer has go; Save sends only the site's own
  const C = adminCard(data, older); await flush();
  assert.ok(C.labelOf("apply_mic_card"));
  C.poll(); await flush();
  assert.equal(C.labelOf("apply_mic_card"), undefined); C.form.fire("submit"); await flush();
  assert.deepEqual(Object.keys(C.posts[0].cfg).sort(), Object.keys(older.fields).sort());
  assert.doesNotMatch(A.fields.textContent + C.fields.textContent, /undefined|MISSING/);
});

// 1.99ahm: "Delay the people list's 🎙 icons" (apply_mic_list) - the 🎙 icons and on-mic order of the pad page's people list and the
// homepage panel's mic chips; its own switch beside the card's and the chat lines', the same offset and the same who / audio rules
test("1.99ahm: the people-list switch - off by default, a strict boolean, audited, in the viewer's answer as apply.mic_list; an older stored row reads it off", async () => {
  assert.equal(AV.DEFAULTS.apply_mic_list, false);
  assert.ok(AV.normalize({ apply_mic_list: "yes" }).errors.apply_mic_list); assert.ok(AV.normalize({ apply_mic_list: 2 }).errors.apply_mic_list);
  assert.equal(AV.normalize({ apply_mic_list: "true" }).cfg.apply_mic_list, true); assert.equal(AV.normalize({ apply_mic_list: 0 }).cfg.apply_mic_list, false);
  // (its own admin: "adm" spent most of its 20 changes a minute in the tests above)
  const LIST_ADMIN = { userId: "adm-list", username: "adm-list", class: "Admin" };
  await assert.rejects(AV.save(LIST_ADMIN, { cfg: { mode: "everyone", apply_mic_list: "on" } }), (e) => e.status === 400 && e.fields.apply_mic_list === "on or off");
  assert.equal(AV.current().cfg.apply_mic_list, false, "nothing saved");
  assert.equal((await get(publicPath(), "v1")).data.apply.mic_list, false);
  const saved = await AV.save(LIST_ADMIN, { cfg: { mode: "everyone", apply_mic_list: true } });
  assert.deepEqual(saved.changed.apply_mic_list, [false, true]);
  assert.equal(saved.changed.apply_mic_card, undefined); assert.equal(saved.changed.apply_mic_chat, undefined);
  const audit = await db.getQuery("SELECT detail FROM admin_audit WHERE action = 'avsync_cfg' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(audit[0].detail).changed.apply_mic_list, [false, true], "audited like the others");
  const on = await get(publicPath(), "v1");
  assert.deepEqual(on.data.apply, { video: true, mic: true, mp3: true, mic_card: false, mic_chat: false, mic_list: true }, "its own switch: the card and the chat stay off");
  assert.doesNotMatch(JSON.stringify(on.data), /frog-example|Example frog/, "the answer names no one");
  // a row saved before this switch existed (the card and chat switches on): it reads off, everything else as it was
  await db.runQuery("UPDATE avsync_cfg SET data = ? WHERE id = 1", [JSON.stringify({ mode: "everyone", apply_mic_card: true, apply_mic_chat: true, cap_ind_ms: 2500 })]);
  AV._reset(); await AV.init();
  assert.deepEqual([AV.current().cfg.apply_mic_card, AV.current().cfg.apply_mic_chat, AV.current().cfg.apply_mic_list, AV.current().cfg.cap_ind_ms], [true, true, false, 2500]);
  assert.equal((await get(publicPath(), "v2")).data.apply.mic_list, false);
  await AV.save(LIST_ADMIN, { reset: true });
  assert.equal(AV.current().cfg.apply_mic_list, false, "reset: off again");
});

test("1.99ahm: the admin card shows \"Delay the people list's 🎙 icons\" under the other mic switches, says what it holds back, and a save sends it", async () => {
  const data = (await get("/api/admin/pepe/avsync", "adm")).data;
  const A = adminCard(data); for (let i = 0; i < 12; i++) await Promise.resolve();
  const list = A.labelOf("apply_mic_list");
  assert.ok(list, "the switch is drawn");
  assert.equal(A.EN["js.admavsync.apply_mic_list"], "Delay the people list's 🎙 icons");
  assert.equal(A.EN["js.admavsync.apply_mic_list_help"], "The 🎙 icons in the people list and its on-mic order, and the homepage's mic chips. Same delay as the mic signs.");
  assert.ok(list.textContent.includes(" Delay the people list's 🎙 icons"), list.textContent);
  assert.ok(list.textContent.includes(A.EN["js.admavsync.apply_mic_list_help"]), list.textContent);
  const order = A.fields.children.map((l) => (l.children.find((c) => c.name) || {}).name);
  assert.deepEqual(order.slice(order.indexOf("apply_mic"), order.indexOf("apply_mic") + 4), ["apply_mic", "apply_mic_card", "apply_mic_chat", "apply_mic_list"]);
  assert.doesNotMatch(A.fields.textContent, /undefined|MISSING/);
  const box = A.labelOf("apply_mic_list").children.find((c) => c.name === "apply_mic_list");
  assert.equal(box.checked, false, "off until an admin ticks it");
  box.checked = true; A.form.fire("change"); A.form.fire("submit");
  assert.equal(A.posts.length, 1); assert.equal(A.posts[0].cfg.apply_mic_list, true);
  assert.deepEqual([A.posts[0].cfg.apply_mic_card, A.posts[0].cfg.apply_mic_chat], [false, false]);
});

// 1.99ait avf (F4, F5): the mic signs' own fallback while the room audio is unmeasured (fallback_ind_rtc_ms / _mp3_ms - the cams keep
// fallback_rtc_ms / _mp3_ms) and mic_follow_toggle (true = a viewer's own toggle also holds the mic signs, as before)
test("1.99ait avf: the mic signs' own fallbacks (2000 / 3000 ms, 0-5000) and mic_follow_toggle (on) - defaults, ranges, a strict boolean, audited, in the viewer's answer; an older stored row reads the defaults", async () => {
  assert.deepEqual([AV.DEFAULTS.fallback_ind_rtc_ms, AV.DEFAULTS.fallback_ind_mp3_ms, AV.DEFAULTS.mic_follow_toggle], [2000, 3000, true]);
  for (const key of ["fallback_ind_rtc_ms", "fallback_ind_mp3_ms"]) {
    assert.deepEqual([AV.FIELDS[key].min, AV.FIELDS[key].max], [0, 5000], key);
    assert.ok(AV.normalize({ [key]: 5001 }).errors[key]); assert.ok(AV.normalize({ [key]: -1 }).errors[key]);
    assert.equal(AV.normalize({ [key]: "4500" }).cfg[key], 4500); assert.equal(AV.normalize({ [key]: 0 }).cfg[key], 0);
  }
  assert.ok(AV.normalize({ mic_follow_toggle: "yes" }).errors.mic_follow_toggle);
  assert.equal(AV.normalize({ mic_follow_toggle: "false" }).cfg.mic_follow_toggle, false);
  assert.equal(AV.normalize({ mic_follow_toggle: 1 }).cfg.mic_follow_toggle, true);
  const A = { userId: "adm-avf", username: "adm-avf", class: "Admin" };
  const before = await get(publicPath(), "v2");
  assert.deepEqual([before.data.fallback_ind, before.data.mic_follow_toggle], [{ rtc: 2000, mp3: 3000 }, true], "the defaults reach viewers");
  const saved = await AV.save(A, { cfg: { mode: "everyone", fallback_ind_rtc_ms: 1800, fallback_ind_mp3_ms: 4500, mic_follow_toggle: false } });
  assert.deepEqual([saved.changed.fallback_ind_rtc_ms, saved.changed.fallback_ind_mp3_ms, saved.changed.mic_follow_toggle], [[2000, 1800], [3000, 4500], [true, false]]);
  const audit = await db.getQuery("SELECT detail FROM admin_audit WHERE action = 'avsync_cfg' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(JSON.parse(audit[0].detail).changed.mic_follow_toggle, [true, false], "audited like the others");
  const on = await get(publicPath(), "v2");
  assert.deepEqual(on.data.fallback_ind, { rtc: 1800, mp3: 4500 }); assert.equal(on.data.mic_follow_toggle, false);
  assert.deepEqual(on.data.fallback, { rtc: 500, mp3: 1500 }, "the cams keep their own fallback");
  // a row saved before these fields existed: the defaults, everything else as it was
  await db.runQuery("UPDATE avsync_cfg SET data = ? WHERE id = 1", [JSON.stringify({ mode: "everyone", fallback_rtc_ms: 400, apply_mic_card: true })]);
  AV._reset(); await AV.init();
  const c = AV.current().cfg;
  assert.deepEqual([c.fallback_ind_rtc_ms, c.fallback_ind_mp3_ms, c.mic_follow_toggle, c.fallback_rtc_ms, c.apply_mic_card], [2000, 3000, true, 400, true]);
  // the admin card draws them with their labels (locales/en.json) and says what they do
  const data = (await get("/api/admin/pepe/avsync", "adm")).data;
  const C = adminCard(data); for (let i = 0; i < 12; i++) await Promise.resolve();
  const follow = C.labelOf("mic_follow_toggle"), rtc = C.labelOf("fallback_ind_rtc_ms"), mp3 = C.labelOf("fallback_ind_mp3_ms");
  assert.ok(follow && rtc && mp3, "drawn");
  assert.ok(follow.textContent.includes(" " + C.EN["js.admavsync.mic_follow_toggle"]) && follow.textContent.includes(C.EN["js.admavsync.mic_follow_toggle_help"]), follow.textContent);
  assert.ok(rtc.textContent.startsWith(C.EN["js.admavsync.fallback_ind_rtc_ms"]) && rtc.textContent.includes("default 2000 · 0–5000") && rtc.textContent.includes(C.EN["js.admavsync.fallback_ind_help"]), rtc.textContent);
  assert.ok(mp3.textContent.startsWith(C.EN["js.admavsync.fallback_ind_mp3_ms"]) && mp3.textContent.includes("default 3000"), mp3.textContent);
  assert.doesNotMatch(C.fields.textContent, /undefined|MISSING/);
  await AV.save(A, { reset: true });
  assert.deepEqual([AV.current().cfg.fallback_ind_rtc_ms, AV.current().cfg.mic_follow_toggle], [2000, true], "reset: the defaults");
});

// 1.99ait avf review (product): the owner calibrates k_pt_ms / k_re_ms from a pad's ?avsync=1 panel - the card has to say which way
// they move the cams (the first try went the wrong way: +650 for cams that were already late) and that a cam can't be shown sooner
// than it arrives; the cams' fallbacks say they are the cams' now that the mic signs have their own
test("1.99ait avf review: the admin card says which way each calibration moves (k_pt_ms, k_re_ms, k_ind_ms) and labels the cams' own fallbacks", async () => {
  const data = (await get("/api/admin/pepe/avsync", "adm")).data;
  const C = adminCard(data); for (let i = 0; i < 12; i++) await Promise.resolve();
  const pt = C.labelOf("k_pt_ms"), re = C.labelOf("k_re_ms"), ind = C.labelOf("k_ind_ms");
  assert.ok(pt && re && ind, "drawn");
  for (const [label, key] of [[pt, "js.admavsync.k_pt_help"], [re, "js.admavsync.k_re_help"], [ind, "js.admavsync.k_ind_help"]]) {
    assert.ok(typeof C.EN[key] === "string" && C.EN[key].length > 20, key + " in locales/en.json");
    assert.ok(label.textContent.includes(C.EN[key]), label.textContent);
  }
  // + = later (av-sync.js videoTarget / indicatorTarget add k): ahead -> raise, behind -> lower
  assert.match(C.EN["js.admavsync.k_pt_help"], /ahead of the voice[^.]*raise/i);
  assert.match(C.EN["js.admavsync.k_pt_help"], /behind[^.]*lower/i);
  assert.match(C.EN["js.admavsync.k_pt_help"], /pass-through/); assert.match(C.EN["js.admavsync.k_pt_help"], /target_ms/);
  assert.match(C.EN["js.admavsync.k_pt_help"], /recordings/, "the mic stage's recordings use it too (avsync.serverOffsetMs)");
  assert.match(C.EN["js.admavsync.k_re_help"], /re-encoded/);
  assert.match(C.EN["js.admavsync.k_ind_help"], /before you hear[^.]*raise/i);
  assert.ok(C.labelOf("fallback_rtc_ms").textContent.startsWith("Cam WebRTC fallback delay (ms)"), C.labelOf("fallback_rtc_ms").textContent);
  assert.ok(C.labelOf("fallback_mp3_ms").textContent.startsWith("Cam MP3 fallback delay (ms)"), C.labelOf("fallback_mp3_ms").textContent);
  assert.doesNotMatch(C.fields.textContent, /undefined|MISSING/);
});
