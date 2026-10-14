// 1.99zc: 🎬 cam stage slots (mainstage camOpen / camBeat + livecam.js stageHold / stageWatch) and the 📌 cam strip /
// Safari fixes on the client (static checks: pad-camstrip.js, the room page's single insertion point, webrtc-client.js's
// autoplay-refused path, room-bridge.js's in-gesture unlock, stage-player.js's native HLS on Safari).
//   node --test test/camstrip.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "camstrip-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const bridge = require(path.join(repo, "bridge"));
const rooms = require(path.join(repo, "rooms"));
const stage = require(path.join(repo, "mainstage"));
const PA = require(path.join(repo, "padaccess"));
const relay = require(path.join(repo, "bridge-relay"));

W.enabled = () => true;
let T = Date.now();
LC._setClock(() => T);
stage._setClock(() => T);
LC._setKick(() => {});
relay.padFull = async () => true;

const ROOM = { id: "Cam.Room", name: "Cam Room" };
let R = null;
function fresh(extra) {
  R = bridge._rooms.get(ROOM.id);
  Object.assign(R, { updated: Date.now(), cams: true, livecams: true, members: [
    { login: "alice", display: "Alice W", on_cam: true }, { login: "bob", display: "Bob", on_cam: true }, { login: "carl", on_cam: false },
    { anon: true, display: "someone", on_cam: true }] }, extra || {});
  return R;
}
const ADMIN = { userId: "u_admin", username: "admin", class: "Admin" };
const OWNER = { userId: "u_owner", username: "owner", class: "pleb" };
const bot = () => LC.forBot({ cap: true });

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 0)`);
  for (const [id, name, cls, cf] of [["u_admin", "admin", "Admin", null], ["u_owner", "owner", "pleb", null], ["u_alice", "alice_patv", "pleb", "alice"],
                                     ["u_v1", "viewer1", "pleb", null], ["u_v2", "viewer2", "pleb", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, cf]);
  }
  await require(path.join(repo, "inbox")).ready;
  await PA.init();
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "a", login: "alice", display: "Alice W" }], count: 1, cams: true, livecams: true }], events: [] });
  await rooms.init();
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await new Promise((r) => setTimeout(r, 20));
  await stage.init();
  await LC.init();
  await LC.save({ class: "Admin", userId: "u_admin", username: "admin" }, { cfg: { enabled: true } });
  await rooms.setStage(ROOM.id, { slot_count: 2 }, "test", { maxSlots: 4, maxPrice: 1000, maxMinutes: 360 });
  fresh();
});

test("livecam stage hold: the consent rules, held without viewers, stage viewers count in the budget but not in personal slots", async () => {
  fresh();
  await assert.rejects(LC.stageHold(R, "alice", "s1", T), (e) => e.code === "nopepe", "Pepe hasn't polled");
  await bot();
  await assert.rejects(LC.stageHold(R, "carl", "s1", T), (e) => e.code === "not_on_cam");
  await assert.rejects(LC.stageHold(R, "someone", "s1", T), (e) => e.code === "not_on_cam", "an anonymous person has no login");
  await LC.setOptout("bob", true, { ts: T });
  await assert.rejects(LC.stageHold(R, "bob", "s1", T), (e) => e.code === "opted_out");
  await LC.setOptout("bob", false, { ts: T + 1 });
  const h = await LC.stageHold(R, "alice", "s1", T);
  assert.equal(h.display, "Alice W");
  await assert.rejects(LC.stageHold(R, "alice", "s2", T), (e) => e.code === "on_stage", "one stage slot per cam");
  // Pepe has it up; no viewers at all, minutes later: still wanted (never "unwatched")
  LC.noteSync([{ name: LC.pathFor(R.id, "alice"), ready: true, readers: [] }], T);
  T += 5 * 60 * 1000; LC.sweep(T);
  const want = (await bot()).want;
  assert.ok(want.some((w) => w.login === "alice"), "Pepe is asked to publish it");
  assert.equal(LC.stageState("s1", T).state, "connecting", "MediaMTX's last word is too old to call it live");
  // a stage viewer: a ticket the MediaMTX hook accepts; not a personal slot
  const r = await LC.stageWatch({ userId: "u_v1" }, { id: R.id }, "s1", {}, T);
  assert.ok(r.whep && /\?pt=/.test(r.whep));
  const p = new URL(r.whep).pathname.split("/").pop();
  assert.equal(await LC.auth({ path: p, query: "pt=" + encodeURIComponent(new URL(r.whep).searchParams.get("pt")) }, "read", "webrtc"), 200);
  assert.equal(LC.hint(R, "u_v1").slots.used, 0, "the stage never takes a viewer's live-cam slot");
  assert.equal((await LC.adminView()).usage.viewers, 1, "but it counts in the bandwidth budget");
  // MediaMTX says it's up -> live
  LC.noteSync([{ name: p, ready: true, readers: [] }], T);
  assert.equal(LC.stageState("s1", T).state, "live");
  // let go: with nobody watching it ends after the linger
  LC.stageRelease("s1", T);
  T += 10 * 60 * 1000; LC.sweep(T);
  assert.equal(LC.stageState("s1", T).state, "none");
  T += 2 * 60 * 1000; LC.sweep(T);
});

test("an opt-out ends a stage-held cam (stageState says why)", async () => {
  fresh();
  await bot();
  await LC.stageHold(R, "bob", "s9", T);
  await LC.setOptout("bob", true, { ts: T + 5 });
  assert.deepEqual([LC.stageState("s9", T).state, LC.stageState("s9", T).why], ["ended", "opted_out"]);
  await LC.setOptout("bob", false, { ts: T + 10 });
});

test("camOpen: owner / staff put a cam on the stage - a free, live-only slot; one per cam; the pad's slot count; consent refused", async () => {
  fresh();
  await bot();
  await assert.rejects(stage.camOpen(ADMIN, { room: ROOM.id, login: "carl" }), (e) => e.status === 400 && e.code === "not_on_cam");
  const r = await stage.camOpen(ADMIN, { room: ROOM.id, login: "alice" });
  const s = r.slot;
  assert.equal(s.cam.login, "alice");
  assert.equal(s.display, "Alice W", "the stage tab shows the cam's name");
  assert.equal(s.held, 0); assert.equal(s.price_per_min, 0);
  assert.equal(s.capture, false, "no snaps / clips of a cam slot");
  assert.equal(s.live, false, "not live until the relay is");
  await assert.rejects(stage.camOpen(ADMIN, { room: ROOM.id, login: "alice" }), /already on this pad's stage/);
  // the cam's owner is told (linked account -> inbox)
  await new Promise((res) => setTimeout(res, 30));
  const box = await getQuery("SELECT title FROM inbox WHERE user_id = 'u_alice' AND kind = 'stage'");
  assert.ok(box.some((b) => /Your cam is on the stage/.test(b.title)), JSON.stringify(box));
  // relay live -> the slot is live (tick), and shows on the stage as a cam (no HLS, a ticket per viewer)
  const p = LC.pathFor(ROOM.id, "alice");
  LC.noteSync([{ name: p, ready: true, readers: [] }], T);
  await stage.tick();
  const pub = await stage.publicSlots(ROOM.id);
  const c = pub.find((x) => x.id === s.id);
  assert.ok(c && c.cam === true && c.hls === null && !c.whep && c.username === null, JSON.stringify(c));
  assert.equal((await stage.getSlot(s.id)).status, "active");
  // a second cam fills the pad's 2 slots; a third is refused
  await stage.camOpen(OWNER, { room: ROOM.id, login: "bob" });
  fresh({ members: R.members.concat([{ login: "dana", display: "Dana", on_cam: true }]) });
  await assert.rejects(stage.camOpen(ADMIN, { room: ROOM.id, login: "dana" }), /slots in this pad are taken/);
  const cands = await stage.camCandidates(ROOM.id);
  assert.deepEqual(cands.cams.map((x) => [x.login, !!x.slot]), [["alice", true], ["bob", true], ["dana", false]]);
});

test("camBeat: leaving cam ends the slot; cutting it lets go of the cam", async () => {
  fresh({ members: [{ login: "alice", display: "Alice W", on_cam: true }, { login: "bob", display: "Bob", on_cam: false }] });
  await bot();
  await stage.tick();
  const open = await stage.openSlots(ROOM.id);
  const bob = (await getQuery("SELECT * FROM stage_slots WHERE cam_login = 'bob' ORDER BY created DESC LIMIT 1"))[0];
  assert.equal(bob.status, "ended");
  assert.equal(bob.end_reason, "cam_left_cam");
  const alice = open.find((x) => x.cam_login === "alice");
  assert.ok(alice);
  await stage.end(alice.id, "cut", "admin");
  assert.equal(LC.stageState(alice.id, T).state, "none", "the hold is gone");
});

test("stage viewer route + the cut route never bans / notifies the person who put a cam up", () => {
  const src = fs.readFileSync(path.join(repo, "mainstage.js"), "utf8");
  assert.match(src, /app\.post\("\/api\/stage\/slots\/:id\/cam"/);
  assert.match(src, /b\.ban && s\.source !== "cam"/);
  assert.match(src, /if \(r && s\.source !== "cam"\) rooms\.notify/);
  assert.match(src, /app\.post\("\/api\/rooms\/:slug\/stage\/cam", addUser, needUser/);
  assert.match(src, /rooms\.canManage\(req\.user, R\.id\)/);
});

test("the strip: a self-contained partial included once in the live room, the popover hands cams over, slots persist per pad", () => {
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.equal((room.match(/include\('partials\/cam-strip'/g) || []).length, 1, "one insertion point");
  assert.match(room, /strip: window\.PATVPadStrip \|\| null, onPin: snapClose/);
  assert.match(room, /PATVPadStrip\.update\(liveCams\)/);
  const part = fs.readFileSync(path.join(repo, "views", "partials", "cam-strip.ejs"), "utf8");
  assert.match(part, /id="rmStrip"/);
  assert.match(part, /pad-camstrip\.js/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "pad-camstrip.js"), "utf8");
  assert.match(js, /'patv\.camstrip\.' \+ slug/);
  assert.match(js, /try \{ localStorage\.setItem/);
  assert.match(js, /scroll-snap|PATVCamStrip/);
  assert.doesNotMatch(js, /innerHTML/, "all text via textContent");
  const plc = fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8");
  assert.match(plc, /strip\.adopt\(who, h\)/);
  assert.match(plc, /window\.PATVLiveCam = \{ row: row, why: why \}/);
  // the pad's own JS runs in a sandbox: the strip restores remembered cams up to the viewer's slots
  const vm = require("vm");
  const store = { "patv.camstrip.pad": JSON.stringify([{ login: "alice", display: "Alice" }, { login: "bob", display: "Bob" }]) };
  const posts = [];
  const mk = () => {
    const e = { children: [], attrs: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); return this._s.has(c); }, contains(c) { return this._s.has(c); } },
                appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); }, setAttribute(k, v) { this.attrs[k] = v; },
                addEventListener() {}, querySelector() { return null }, play() { return Promise.resolve(); } };
    return e;
  };
  const ctx = { window: {}, document: { createElement: mk }, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
                fetch: (u, o) => { posts.push([u, JSON.parse(o.body)]); return Promise.resolve({ json: () => Promise.resolve({ ok: false, code: "nopepe" }) }); },
                PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, setInterval, clearInterval, setTimeout, console };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  vm.runInNewContext(js, ctx);
  const host = mk();
  const strip = ctx.PATVCamStrip.init(host, "pad", {});
  strip.update({ on: true, slots: { used: 0, max: 1 }, sp_max: 4 });
  assert.equal(strip.count(), 2, "both remembered cams come back");
  assert.deepEqual(posts.map((p) => p[1].login), ["alice"], "only as many tickets as the viewer has slots");
  assert.equal(strip.full(), true);
  assert.equal(strip.has("bob"), true);
});

test("Safari: autoplay refused resolves (tap-to-play), audio unlocked in the tap, native HLS on Safari", () => {
  const rtc = fs.readFileSync(path.join(repo, "public", "js", "webrtc-client.js"), "utf8");
  assert.match(rtc, /err\.name === 'NotAllowedError'\) res\('blocked'\)/);
  assert.equal((rtc.match(/return started\(video\);/g) || []).length, 2, "play() and watch() both");
  const rb = fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8");
  assert.match(rb, /function start\(\) \{\r?\n\s+unlock\(\);/);
  assert.match(rb, /if \(c\.state !== 'running' && !shared\.unlocked\) return;/);
  const sp = fs.readFileSync(path.join(repo, "public", "js", "stage-player.js"), "utf8");
  assert.match(sp, /overrideNative: !nativeHls\(\)/);
});
