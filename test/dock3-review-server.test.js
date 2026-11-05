// dock3 review fixes 1.99?? - the server side of item 5 (★ Feature on Pepe's stage) and item 6 (mic follows never interrupts a featured
// stage), after the correctness / mic-follows reviews. Each test failed on the dock3 build before these fixes:
//   C1 / S4  Pepe's per-pad feature stood while his stream was OFF AIR: no stream there was ever auto-featured and pepe_src.featured stayed
//            true (the page parked viewers on his off-air slate) - now it counts while he is in the pad and on air, through a short drop
//   C4       Pepe briefly out of the pad (a bot restart / rejoining rooms one at a time): the next tick auto-featured a live stream and that
//            DELETED the owner's Pepe feature for good - an auto-feature never ends it now (it yields to him when he is back)
//   C3       two ★ presses at once (or a ★ and a hand feature on another pad) lost one pad's Pepe feature - setConfig is serialized and the
//            per-pad map is changed inside it
//   MF4 / S2 featuring a booking that starts LATER ended Pepe's per-pad feature (and unfeatured the live auto stream) at once
//   MF3 / S3 a featured booking OPENING (lead_min early, nobody publishing yet) unfeatured the live auto stream - nothing featured could
//            show for up to lead_min + start_window_min; now the live stream keeps it until the booking is live
//   MF6 / S1 /api/stage never read the sign-in for a DROPPED featured 🎬 cam slot (featured: null, so the page's hold never engaged)
//   MF2      the homepage Dock polled /api/stage with no pad: a front-page change applied the NEW front pad's stage to the old block (its mic
//            stage over its featured stream) - it now asks for its own pad (?room=<slug>&home=1: the homepage's rules, `front` still says
//            what the front page shows now)
//   node --test test/dock3-review-server.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dock3-review-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const B = require(path.join(repo, "bridge"));

let T = Date.now();
S._setClock(() => T);
const adv = (ms) => { T += ms; };
let AIR = true;
if (S._setPepeAir) S._setPepeAir(() => AIR);       // (dock3 review: on air or not - bridge.pepeOnAir in production)
let n = 0;
async function mkUser() {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 0)", [id, "streamer" + n, "Streamer " + n]);
  return { userId: id, username: "streamer" + n };
}
const pub = (name, cid) => S.rtmpCallback({ call: "publish", app: "stage", name, addr: "1.2.3.4", clientid: String(cid) });
const upd = (name, cid) => S.rtmpCallback({ call: "update_publish", app: "stage", name, addr: "1.2.3.4", clientid: String(cid) });
let cids = 0;
async function live(room) {
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30, room });
  const cid = ++cids;
  assert.equal((await pub(b.key, cid)).status, 302);
  return { id: b.slot.id, key: b.key, cid, user: u };
}
const feat = async (id) => { const s = await S.getSlot(id); return s.featured ? s.feature_by : null; };
const HOUSE = rooms.HOUSE_ROOM;
/** keep a live stream live while the clock moves (beats every 10 s) */
async function walk(ms, ...streams) { for (let d = 0; d < ms; d += 10000) { adv(10000); for (const a of streams) await upd(a.key, a.cid); await S.tick(); } }
const away = () => B._rooms.set("Elsewhere.Room", { id: "Elsewhere.Room", name: "Elsewhere", updated: Date.now() + 3600 * 1000, members: [], mic: [] });
const back = () => B._rooms.delete("Elsewhere.Room");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, schedule_per_user: 10, enabled: true, takeover_mode: "when_idle", pepe_feature: null, pepe_feature_pads: {} }, "test");
  await rooms.setStage(HOUSE, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
});
test.afterEach(async () => {
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  await S.setConfig({ pepe_feature_pads: {} }, "test");
  AIR = true; back();
});

test("C1 / S4: Pepe featured on this pad goes OFF AIR - held a minute, then a live stream there is auto-featured and his ★ goes; back on air: his again", async () => {
  assert.deepEqual(await S.setPadPepeFeature(HOUSE, true, "owner1"), { featured: true });
  const a = await live();
  await S.tick();
  assert.equal(await feat(a.id), null, "on air: his feature holds the auto-feature off");
  AIR = false;
  await S.tick();
  assert.equal(await feat(a.id), null, "an OBS blip: still his");
  assert.equal(S.pepeSource(undefined, HOUSE).featured, true, "(and the page still shows his ★ through the blip)");
  await walk(30000, a);
  assert.equal(await feat(a.id), null, "half a minute off air: still held");
  await walk(40000, a);
  assert.equal(await feat(a.id), "auto", "off air past the hold: the live stream is the pad's featured stream");
  const src = S.pepeSource(undefined, HOUSE);
  assert.equal(src.featured, false, "pepe_src.featured: no ★ on an off-air stream");
  assert.equal(src.pad_featured, true, "...but the pad still features him (the manager's ☆ Unfeature)");
  assert.ok(S.config().pepe_feature_pads[HOUSE], "kept - it was the owner's choice");
  AIR = true;
  await upd(a.key, a.cid); await S.tick();
  assert.equal(await feat(a.id), null, "back on air: the auto-feature yields to him");
  assert.equal(S.pepeSource(undefined, HOUSE).featured, true);
});

test("C4: Pepe briefly out of the pad - no auto-feature through the hold, and one after it never deletes his feature: he gets it back on return", async () => {
  const a = await live();
  await S.tick();
  assert.equal(await feat(a.id), "auto");
  await S.setPadPepeFeature(HOUSE, true, "owner1");
  assert.equal(await feat(a.id), null);
  away();
  assert.equal(B.pepeIn(HOUSE), false, "(he is in another room only)");
  await upd(a.key, a.cid); await S.tick();
  assert.equal(await feat(a.id), null, "rejoining rooms one at a time: held");
  await walk(70000, a);
  assert.equal(await feat(a.id), "auto", "away past the hold: the live stream is featured");
  assert.ok(S.config().pepe_feature_pads[HOUSE], "the auto-feature did NOT delete the owner's Pepe feature");
  back();
  await upd(a.key, a.cid); await S.tick();
  assert.equal(await feat(a.id), null, "he is back: the auto-feature yields");
  assert.ok(S.padPepeFeatured(HOUSE), "his feature counts again");
});

test("C3: two ★ presses at once (two pads), and a ★ racing a hand feature on another pad - no pad's Pepe feature is lost", async () => {
  await Promise.all([S.setPadPepeFeature(HOUSE, true, "owner1"), S.setPadPepeFeature("Other.Pad", true, "owner2")]);
  assert.deepEqual(Object.keys(S.config().pepe_feature_pads).sort(), [HOUSE, "Other.Pad"].sort(), "both stored");
  // a ☆ on one pad while a ★ lands on a third
  await Promise.all([S.setPadPepeFeature("Other.Pad", false, "owner2"), S.setPadPepeFeature("Third.Pad", true, "owner3")]);
  assert.deepEqual(Object.keys(S.config().pepe_feature_pads).sort(), [HOUSE, "Third.Pad"].sort());
  // a hand feature on the house pad (clears its entry) racing a ★ on another pad
  const a = await live();
  await Promise.all([S.featureByOwner(a.id, "owner1"), S.setPadPepeFeature("Fourth.Pad", true, "owner4")]);
  assert.deepEqual(Object.keys(S.config().pepe_feature_pads).sort(), ["Fourth.Pad", "Third.Pad"].sort());
  // setConfig itself: two admin saves at once keep both keys
  await Promise.all([S.setConfig({ min_minutes: 3 }, "a"), S.setConfig({ max_concurrent: 7 }, "b")]);
  assert.equal(S.config().min_minutes, 3); assert.equal(S.config().max_concurrent, 7);
  await S.setConfig({ min_minutes: 2, max_concurrent: 6 }, "test");
});

test("MF4 / S2: featuring a booking that starts tomorrow ends neither Pepe's per-pad feature nor the live auto stream's feature now", async () => {
  const a = await live();
  await S.tick();
  assert.equal(await feat(a.id), "auto");
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30, room: HOUSE, start_at: T + 24 * 3600 * 1000 });
  assert.equal((await S.getSlot(b.slot.id)).status, "scheduled");
  await S.featureByOwner(b.slot.id, "owner1");
  assert.equal(await feat(b.slot.id), "owner", "the booking is featured (it takes over when it starts)");
  assert.equal(await feat(a.id), "auto", "the live stream keeps its feature until then");
  await S.end(a.id, "test", "test");
  await S.setPadPepeFeature(HOUSE, true, "owner1");
  const u2 = await mkUser();
  const b2 = await S.book(u2, { minutes: 30, room: HOUSE, start_at: T + 48 * 3600 * 1000 });
  await S.featureByOwner(b2.slot.id, "owner1");
  assert.ok(S.padPepeFeatured(HOUSE), "a booking two days away doesn't end Pepe's feature here now");
});

test("MF3 / S3: a featured booking opens before its start - the live auto stream keeps the feature until the booking goes LIVE; then the booking alone (and Pepe's pad feature ends)", async () => {
  const a = await live();
  await S.tick();
  assert.equal(await feat(a.id), "auto");
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30, room: HOUSE, start_at: T + 7 * 60000 });
  await S.featureByOwner(b.slot.id, "owner1");
  await walk(160000, a);
  const bs = await S.getSlot(b.slot.id);
  assert.equal(bs.status, "waiting", "(the booking opened - its key works - nobody publishes yet)");
  assert.equal(await feat(a.id), "auto", "the live stream is still the pad's featured stream");
  S.clearCache();
  const f = await S.featuredOf(HOUSE, null);
  assert.equal(f && f.id, a.id, "and /api/stage names the LIVE featured slot, not the waiting booking");
  assert.ok((await S.publicSlots(HOUSE)).some((s) => s.id === a.id && s.featured), "listed featured");
  // the booking goes live: it takes over (and a Pepe feature stored meanwhile ends - one featured stream per pad)
  await S.setConfig((C) => ({ pepe_feature_pads: { ...C.pepe_feature_pads, [HOUSE]: { by: "owner1", at: T } } }), "test");
  const cid = ++cids;
  assert.equal((await pub(bs.stream_key || b.key, cid)).status, 302);
  await S.tick();
  assert.equal(await feat(b.slot.id), "owner", "the booking is featured");
  assert.equal(await feat(a.id), null, "the auto-feature yielded to the LIVE booking");
  assert.equal(S.config().pepe_feature_pads[HOUSE], undefined, "a live hand / booked feature ends Pepe's pad feature");
});

test("MF6 / S1 + MF2: /api/stage reads the sign-in for a dropped featured 🎬 cam; ?room=<pad>&home=1 answers that pad by the homepage's rules with `front`", async () => {
  // a 🎬 cam slot the owner featured, its relay down for > 30 s: open, featured, not live
  await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held, stream, publishing, beat,
                  went_live, last_live, settled, room_id, kind, featured, feature_by, mode, source, cam_login)
                  VALUES ('c1', 'owner1', NULL, 'Alice W', 'active', ?, 30, 0, 0, 'cam-0011223344556677', 0, ?, ?, ?, 0, ?, 'slot', 1, 'owner', 'stream', 'cam', 'alicecf')`,
                 [T - 300000, T - 60000, T - 240000, T - 40000, HOUSE]);
  S.clearCache();
  // no Approved pad anywhere (the handler then reads the sign-in only for a reason of its own)
  PA._reset(); await PA.init();
  for (const s of rooms.SEEDS) await runQuery("INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES (?, 'members', ?, 'test') ON CONFLICT(room_id) DO UPDATE SET level = 'members'", [s.room_id, T]);
  await runQuery("UPDATE pad_access SET level = 'members' WHERE level = 'approved'");
  PA._reset(); await PA.init();
  assert.equal(PA.anyApproved(), false);
  const express = require(path.join(repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const h = req.headers["x-u"]; req.user = h ? { userId: h, username: h, class: "pleb" } : null; next(); };
  B.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const get = async (q, u) => (await fetch(base + "/api/stage" + q, { headers: u ? { "x-u": u } : {} })).json();
  try {
    const slug = require(path.join(repo, "roomsweb")).linkSlug(await rooms.get(HOUSE));
    let d = await get("?room=" + encodeURIComponent(slug), "v1");
    assert.ok(!d.stale);
    assert.deepEqual(d.featured, { id: "c1", live: false, by: "owner", went: true }, "MF6: the signed-in viewer's poll names the dropped featured cam - the page holds it");
    d = await get("?room=" + encodeURIComponent(slug));
    assert.equal(d.featured, null, "signed out: past its rule");
    // MF2: the homepage Dock asks for ITS pad with the homepage's rules - a featured cam is never named there, and `front` says what the
    // front page shows now (the Dock swaps its block when that changes)
    const plain = await get("", "v1");
    d = await get("?room=" + encodeURIComponent(slug) + "&home=1", "v1");
    assert.ok(!d.stale);
    assert.equal(d.featured, null, "home=1: no cam slot on the homepage (D-21)");
    assert.ok(!(d.slots || []).some((s) => s && s.cam), "nor listed");
    assert.deepEqual(d.front, plain.front, "front = the front page's pad, as a plain homepage poll answers it");
    assert.ok(plain.front && plain.front.slug === slug, "(the house pad is the front page here)");
    assert.ok("pepe_src" in d && "slots" in d);
    // the Dock's block is ANOTHER pad than the front page now: that pad's stage (not the front's), and `front` names the new front
    const a = await live();
    S.clearCache();
    const Lg = await rooms.get(rooms.LOUNGE_ID);
    assert.ok(Lg, "(the lounge seed pad)");
    const lslug = require(path.join(repo, "roomsweb")).linkSlug(Lg);
    const fp = await get("", "v1");
    assert.ok(fp.slots.some((s) => s.id === a.id), "(the front pad's live stream, on a plain homepage poll)");
    d = await get("?room=" + encodeURIComponent(lslug) + "&home=1", "v1");
    assert.ok(!d.slots.some((s) => s.id === a.id), "the block's own pad - not the front pad's stream");
    assert.deepEqual(d.front, fp.front, "and `front` says the front page shows the house pad now (the Dock swaps)");
  } finally { srv.close(); }
  const hd = fs.readFileSync(path.join(repo, "public", "js", "home-dock.js"), "utf8");
  assert.match(hd, /api: frontSlug \? '\/api\/stage\?room=' \+ encodeURIComponent\(frontSlug\) \+ '&home=1' : '\/api\/stage'/, "MF2: the Dock polls its own pad");
});

test("weak-test note: POST /api/stage/pepe/feature as a REQUEST - signed out 401, a viewer 403 (the slot buttons' rule), site staff 200; Pepe away 409", async () => {
  const express = require(path.join(repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const h = req.headers["x-u"]; req.user = h ? { userId: h, username: h, class: req.headers["x-c"] || "pleb" } : null; next(); };
  S.register(app, { addUser, isBotToken: () => false, noTimers: true });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const post = async (body, u, c) => { const r = await fetch(base + "/api/stage/pepe/feature", { method: "POST", headers: { "content-type": "application/json", ...(u ? { "x-u": u } : {}), ...(c ? { "x-c": c } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, j: await r.json().catch(() => null) }; };
  try {
    const slug = require(path.join(repo, "roomsweb")).linkSlug(await rooms.get(HOUSE));
    assert.equal((await post({ room: slug, on: true })).status, 401, "signed out");
    const v = await post({ room: slug, on: true }, "viewer1");
    assert.equal(v.status, 403, "a viewer who doesn't manage the pad"); assert.equal(S.config().pepe_feature_pads[HOUSE], undefined);
    const o = await post({ room: slug, on: true }, "boss", "Admin");
    assert.equal(o.status, 200); assert.deepEqual(o.j, { ok: true, featured: true }); assert.ok(S.config().pepe_feature_pads[HOUSE]);
    assert.deepEqual((await post({ room: slug, on: false }, "boss", "Admin")).j, { ok: true, featured: false });
    assert.equal((await post({ room: "no-such-pad", on: true }, "boss", "Admin")).status, 404);
    away();
    const a = await post({ room: slug, on: true }, "boss", "Admin");
    assert.equal(a.status, 409, "Pepe isn't in this pad");
  } finally { srv.close(); back(); }
});
