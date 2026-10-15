// Offline tests for 📺 On Pepe's OBS (onair.js, 1.99yt POC): putting a live slot / a cam on Pepe's main stream, the
// kill switch, what's refused (embeds, private pads, Plex unless allowed, a cam without its owner's opt-in / opted out of
// live cams), Pepe's poll (target + URL, opt-ins typed in Camfrog, !onair commands incl. a streamer taking themselves
// off), ending by itself (slot ended / off air past the grace, cam off cam), the log.
//   node --test test/onair.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onair-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const B = require(path.join(repo, "bridge"));
const LC = require(path.join(repo, "livecam"));
const OA = require(path.join(repo, "onair"));

let T = 1_800_000_000_000;
S._setClock(() => T);
OA._setClock(() => T);
rooms.notify = async () => true;          // no inbox / PM queue in these tests
let n = 0, cids = 0;
async function mkUser(cf) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 0, ?)",
    [id, "streamer" + n, "Streamer " + n, cf || null]);
  return { userId: id, username: "streamer" + n };
}
const pub = (name, cid) => S.rtmpCallback({ call: "publish", app: "stage", name, addr: "1.2.3.4", clientid: String(cid) });
async function live(room, cf) {
  const u = await mkUser(cf);
  const b = await S.book(u, { minutes: 30, room });
  assert.equal((await pub(b.key, ++cids)).status, 302);
  return { id: b.slot.id, user: u };
}
const PRIV = "Private.Room";
const CAMROOM = { id: rooms.HOUSE_ROOM, name: "Pepe's pad", slug: "pepes-pad", cams: true, livecams: true, updated: Date.now(), members: [
  { login: "alice", display: "Alice", on_cam: true }, { login: "bob", on_cam: true }, { login: "carl", on_cam: false },
  { login: "pepefrog", on_cam: true, self: true }] };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, enabled: true }, "test");
  await rooms.setStage(rooms.HOUSE_ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await PA.init();
  await runQuery("INSERT INTO pad_access (room_id, level) VALUES (?, 'approved')", [PRIV]);
  await PA.load();
  await LC.init();
  await OA.init();
  B._rooms.set(CAMROOM.id, CAMROOM);
});
test.afterEach(async () => {
  await OA.clear("test", "test");
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  await OA.saveConfig({ enabled: true, cam_optin: true, allow_library: false }, "test");
});

test("defaults: off on prod (kill switch), cams need an opt-in, no Plex", async () => {
  assert.equal(OA.DEFAULTS.enabled, false);
  assert.equal(OA.DEFAULTS.cam_optin, true);
  assert.equal(OA.DEFAULTS.allow_library, false);
  assert.equal(OA.DEFAULTS.irl_source, "IRL BB");
  assert.deepEqual(OA.clean({ enabled: "maybe", scene: "", cam_fps: 99 }).errors, { enabled: "on or off", scene: "an OBS name (1-60 characters)", cam_fps: "5–30" });
});

test("switched off: nothing can be set; switching off takes the target down", async () => {
  const a = await live();
  await OA.saveConfig({ enabled: false }, "test");
  await assert.rejects(OA.setSlot(a.id, "t"), (e) => e.code === "off");
  await OA.saveConfig({ enabled: true }, "test");
  await OA.setSlot(a.id, "t");
  assert.ok(OA.view().target);
  await OA.saveConfig({ enabled: false }, "test");
  assert.equal(OA.view().target, null);
  const r = await OA.forBot({ state: { obs: "ok" } });
  assert.equal(r.target, null);
  const logs = await getQuery("SELECT what, detail FROM onair_log ORDER BY id");
  assert.ok(logs.some((l) => l.what === "end" && l.detail === "switched_off"));
});

test("a live public slot goes on air; Pepe gets its HLS URL; the streamer is told", async () => {
  const told = [];
  rooms.notify = async (uid, n) => { told.push([uid, n.title]); return true; };
  const a = await live();
  await OA.setSlot(a.id, "web:boss");
  const r = await OA.forBot({ state: { obs: "ok", shown: true, irl: false, scene: "Pepe", source_ok: true } });
  assert.equal(r.target.kind, "slot");
  assert.match(r.target.url, /^https:\/\/publicaccess\.tv\/hls\/stage-[0-9a-f]{16}\.m3u8$/);
  assert.equal(r.cfg.irl_source, "IRL BB");
  assert.deepEqual(told, [[a.user.userId, "You're on Pepe's main stream"]]);
  assert.equal(OA.view().pepe.state.scene, "Pepe");
  rooms.notify = async () => true;
});

test("refused: not live, private pad, embed, Plex unless allowed", async () => {
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30 });              // booked, never went live
  await assert.rejects(OA.setSlot(b.slot.id, "t"), (e) => e.code === "not_live");
  await assert.rejects(OA.setSlot("nope", "t"), (e) => e.code === "gone");
  const s = await S.getSlot((await live()).id);
  assert.equal(await OA.slotWhyNot({ ...s, room_id: PRIV }), "pad_private");
  assert.equal(await OA.slotWhyNot({ ...s, mode: "embed" }), "embed");
  assert.equal(await OA.slotWhyNot({ ...s, nsfw: 1 }), "nsfw");
  assert.equal(await OA.slotWhyNot({ ...s, source: "library" }), "library");
  await OA.saveConfig({ allow_library: true }, "test");
  assert.equal(await OA.slotWhyNot({ ...s, source: "library" }), null);
});

test("ends by itself: the slot ends; off air past the grace", async () => {
  const a = await live();
  await OA.setSlot(a.id, "t");
  await S.end(a.id, "done", "test");
  await OA.check();
  assert.equal(OA.view().target, null);
  const b = await live();
  await OA.setSlot(b.id, "t");
  T += 60 * 1000;                                           // beats stop: not live, still inside the grace
  await OA.check();
  assert.ok(OA.view().target);
  T += OA.LIVE_GRACE_MS;
  await OA.check();
  assert.equal(OA.view().target, null);
  const last = (await getQuery("SELECT what, detail FROM onair_log ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([last.what, last.detail], ["end", "not_live"]);
});

test("cams: need the owner's opt-in (web or !onair me on), never Pepe himself or someone off cam; live cam opt-out wins", async () => {
  CAMROOM.updated = Date.now();
  await assert.rejects(OA.setCam(CAMROOM.id, "alice", "t"), (e) => e.code === "no_optin");
  await assert.rejects(OA.setCam(CAMROOM.id, "carl", "t"), (e) => e.code === "not_on_cam");
  await assert.rejects(OA.setCam(CAMROOM.id, "pepefrog", "t"), (e) => e.code === "self");
  await OA.forBot({ optin_events: [{ login: "alice", on: true, ts: T }] });   // typed in Camfrog
  assert.equal(OA.optedIn("alice"), true);
  await OA.setCam(CAMROOM.id, "alice", "t");
  const r = await OA.forBot({});
  assert.deepEqual([r.target.kind, r.target.room, r.target.login], ["cam", CAMROOM.id, "alice"]);
  assert.ok(r.optin.includes("alice"));
  await LC.setOptout("alice", true, { via: "web" });       // live cam off -> off the main stream too
  await OA.check();
  assert.equal(OA.view().target, null);
  await LC.setOptout("alice", false, { via: "web", ts: T + 1 });
  await OA.setCam(CAMROOM.id, "alice", "t");
  await OA.setOptin("alice", false, { ts: T + 2 });          // withdrawing the opt-in takes it off at once
  assert.equal(OA.view().target, null);
  await OA.saveConfig({ cam_optin: false }, "test");
  await OA.setCam(CAMROOM.id, "bob", "t");                   // opt-in not required (admin's choice)
  CAMROOM.members.find((m) => m.login === "bob").on_cam = false;
  await OA.check();
  assert.equal(OA.view().target, null);
  CAMROOM.members.find((m) => m.login === "bob").on_cam = true;
});

test("!onair from Camfrog: admins set by pad / user / id prefix, off; the streamer takes themselves off; others can't", async () => {
  const a = await live(undefined, "streamcf");
  let r = await OA.botCommand({ action: "set", query: "streamer" + n, by: "adminguy", admin: true });
  assert.equal(r.ok, true, r.msg);
  assert.equal(OA.view().target.slot_id, a.id);
  r = await OA.botCommand({ action: "set", query: a.id.slice(0, 8), by: "adminguy", admin: true });
  assert.equal(r.ok, true, r.msg);
  r = await OA.botCommand({ action: "set", query: "nobody-here", by: "adminguy", admin: true });
  assert.equal(r.ok, false);
  assert.match(r.msg, /No live slot matches/);
  r = await OA.botCommand({ action: "set", query: "x", by: "pleb" });
  assert.deepEqual(r, { ok: false, msg: "Admins only." });
  r = await OA.botCommand({ action: "leave", by: "randomguy" });
  assert.equal(r.ok, false);
  r = await OA.botCommand({ action: "leave", by: "StreamCF" });           // their linked Camfrog login
  assert.equal(r.ok, true);
  assert.equal(OA.view().target, null);
  await OA.setSlot(a.id, "t");
  r = await OA.botCommand({ action: "off", by: "adminguy", admin: true });
  assert.equal(r.ok, true);
  assert.equal(OA.view().target, null);
  r = await OA.botCommand({ action: "status", by: "x" });
  assert.match(r.msg, /Nothing is on Pepe's main stream/);
});

test("the target survives a restart (persisted); the admin view lists slots / cams with the reason they can't go", async () => {
  const a = await live();
  await OA.setSlot(a.id, "t");
  const id = OA.view().target.id;
  OA._reset();
  await OA.init();
  assert.equal(OA.view().target.id, id);
  CAMROOM.updated = Date.now();
  const v = await OA.adminView();
  assert.ok(v.slots.some((s) => s.id === a.id && s.why === null));
  assert.ok(v.cams.some((c) => c.login === "carl") === false);                 // off cam: not listed
  assert.equal(v.cams.find((c) => c.login === "bob").why, "no_optin");
  assert.ok(v.log.length > 0);
});

test("IRL auto-switch settings: on by default, irl_from a clean comma list, sent to Pepe regardless of the on-air switch", async () => {
  assert.equal(OA.DEFAULTS.irl_switch, true);
  assert.equal(OA.DEFAULTS.irl_from, "BRB, Gaming");
  assert.equal(OA.clean({ irl_from: " BRB ,Starting Soon,, Gaming " }).cfg.irl_from, "BRB, Starting Soon, Gaming");
  assert.ok(OA.clean({ irl_from: Array(14).fill("X").join(",") }).errors.irl_from);
  await OA.saveConfig({ enabled: false, irl_switch: true, irl_from: "BRB" }, "test");
  const r = await OA.forBot({ state: { irl_watch: "on", irl_switched_from: "BRB" } });
  assert.deepEqual([r.cfg.enabled, r.cfg.irl_switch, r.cfg.irl_from], [false, true, "BRB"]);
  assert.equal(OA.view().pepe.state.irl_watch, "on");
  await OA.saveConfig({ irl_from: "BRB, Gaming" }, "test");
});
