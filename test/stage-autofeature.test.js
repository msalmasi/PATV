// Offline tests for 1.99lm - AUTO-FEATURE ("take-over", mainstage.js autoFeature): a user stream that goes live on a
// pad where nothing is featured becomes the pad's featured stream (feature_by 'auto') until it ends; the next live
// one takes over, else Pepe's stream; never while Pepe's stream is featured (pepe_feature) or over a real feature;
// takeover_mode off | when_idle, per pad (rooms.takeover); admins cancel it.
//   node --test test/stage-autofeature.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-auto-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));

let T = 1_800_000_000_000;
S._setClock(() => T);
const adv = (ms) => { T += ms; };
let n = 0;
async function mkUser() {
  const id = "a" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 0)", [id, "streamer" + n, "Streamer " + n]);
  return { userId: id, username: "streamer" + n };
}
const pub = (name, cid) => S.rtmpCallback({ call: "publish", app: "stage", name, addr: "1.2.3.4", clientid: String(cid) });
const upd = (name, cid) => S.rtmpCallback({ call: "update_publish", app: "stage", name, addr: "1.2.3.4", clientid: String(cid) });
const done = (name, cid) => S.rtmpCallback({ call: "publish_done", app: "stage", name, addr: "1.2.3.4", clientid: String(cid) });
let cids = 0;
/** book a free slot on the house pad and go live on it -> {id, key, cid} */
async function live(room) {
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30, room });
  const cid = ++cids;
  assert.equal((await pub(b.key, cid)).status, 302);
  return { id: b.slot.id, key: b.key, cid, user: u };
}
const feat = async (id) => { const s = await S.getSlot(id); return s.featured ? s.feature_by : null; };
const featuredIn = async (room) => (await getQuery("SELECT id, feature_by FROM stage_slots WHERE room_id = ? AND featured = 1 AND status IN ('waiting','active')", [room]));
async function clear() {
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  await S.setConfig({ takeover_mode: "when_idle", pepe_feature: null, pepe_feature_pads: {} }, "test");
  await rooms.setStage(rooms.HOUSE_ROOM, { takeover: "" }, "test", { maxSlots: 4, maxPrice: 0 });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, enabled: true }, "test");
  await rooms.setStage(rooms.HOUSE_ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
});
test.afterEach(clear);

test("defaults: takeover_mode when_idle, nobody featured Pepe; a bad mode is cleaned", async () => {
  assert.equal(S.DEFAULTS.takeover_mode, "when_idle");
  assert.equal(S.config().takeover_mode, "when_idle");
  assert.equal(S.config().pepe_feature, null);
  await S.setConfig({ takeover_mode: "always" }, "test");
  assert.equal(S.config().takeover_mode, "when_idle");
  await S.setConfig({ takeover_mode: "off" }, "test");
  assert.equal(S.config().takeover_mode, "off");
});

test("take-over when idle: the first stream to go live is the pad's featured stream (auto); booking alone isn't", async () => {
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30 });
  assert.equal(await feat(b.slot.id), null, "waiting to go live = not featured");
  assert.equal((await pub(b.key, 901)).status, 302);
  assert.equal(await feat(b.slot.id), "auto");
  const list = await S.publicSlots(rooms.HOUSE_ROOM);
  assert.equal(list[0].id, b.slot.id);
  assert.equal(list[0].featured, true);
  assert.equal(list[0].feature_by, "auto");
  const st = await S.roomStage(rooms.HOUSE_ROOM, null);
  assert.equal(st.featured.id, b.slot.id);
  assert.equal(st.featured.by, "auto");
  const ev = await getQuery("SELECT * FROM stage_events WHERE slot_id = ? AND what = 'featured'", [b.slot.id]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor, "system");
});

test("fallback on end: the stage goes back to Pepe's stream (nothing featured)", async () => {
  const a = await live();
  assert.equal(await feat(a.id), "auto");
  await S.end(a.id, "owner_ended", a.user.username);
  assert.deepEqual(await featuredIn(rooms.HOUSE_ROOM), []);
  const s = await S.getSlot(a.id);
  assert.equal(s.featured, 0);
});

test("two user streams: the second isn't featured; when the first ends the second takes over", async () => {
  const a = await live();
  adv(5000);
  const b = await live();
  assert.equal(await feat(a.id), "auto");
  assert.equal(await feat(b.id), null, "a stream is already featured");
  assert.equal((await featuredIn(rooms.HOUSE_ROOM)).length, 1);
  await S.end(a.id, "owner_ended", "x");
  assert.equal(await feat(b.id), "auto", "handed over to the stream still live");
  // a third one that went live meanwhile doesn't steal it
  const c = await live();
  assert.equal(await feat(c.id), null);
});

test("hand-over picks the stream that went live first; a dropped stream keeps it for the hold, then hands over", async () => {
  const a = await live();
  adv(3000); const b = await live();
  adv(3000); const c = await live();
  // a's encoder drops: no heartbeat, publish_done
  await done(a.key, a.cid);
  adv(30 * 1000);
  await upd(b.key, b.cid); await upd(c.key, c.cid);
  await S.tick();
  assert.equal(await feat(a.id), "auto", "kept through a short drop");
  adv(40 * 1000);
  await upd(b.key, b.cid); await upd(c.key, c.cid);
  await S.tick();
  assert.equal(await feat(a.id), null, "dropped longer than the hold -> handed over");
  assert.equal(await feat(b.id), "auto", "the earliest live one");
  assert.equal(await feat(c.id), null);
});

test("dock3 1.99??: featuredOf - the pad's featured slot LIVE OR NOT (a drop keeps it named, live: false), went, never on another pad; null once it ends", async () => {
  const a = await live();
  await S.tick();
  let f = await S.featuredOf(rooms.HOUSE_ROOM, null);
  assert.deepEqual(f, { id: a.id, live: true, by: "auto", went: true });
  assert.ok((await S.publicSlots(rooms.HOUSE_ROOM)).some((s) => s.id === a.id), "listed while live");
  await done(a.key, a.cid);                                  // a 📼 seek / an OBS reconnect: publish_done
  adv(3000);
  assert.ok(!(await S.publicSlots(rooms.HOUSE_ROOM)).some((s) => s.id === a.id), "out of the live list for the moment");
  f = await S.featuredOf(rooms.HOUSE_ROOM, null);
  assert.deepEqual(f, { id: a.id, live: false, by: "auto", went: true }, "still named featured - the page holds it");
  assert.equal(await S.featuredOf("Some.Other.Room", null), null, "another pad's");
  assert.equal(await S.featuredOf(null, null), null);
  await S.end(a.id, "test", "test"); adv(3000);
  assert.equal(await S.featuredOf(rooms.HOUSE_ROOM, null), null, "ended: nothing featured");
  const src = fs.readFileSync(path.join(repo, "mainstage.js"), "utf8");
  assert.match(src, /if \(f\.cam && \(front \|\| !camVisible\(roomId, viewer\)\)\) return null;/, "a featured cam slot: never on the homepage, never past its rule");
});

test("Pepe featured: no take-over; an auto-feature that's up is dropped; it comes back when his feature ends", async () => {
  const a = await live();
  assert.equal(await feat(a.id), "auto");
  adv(1000);
  const w = await S.setPepeFeature({ minutes: 10, note: "Friday show" }, "admin1");
  assert.ok(w && w.until === T + 10 * 60000);
  assert.ok(S.pepeFeatured());
  assert.equal(S.pepeSource().featured, true, "the ★ on Pepe's tab");
  assert.equal(await feat(a.id), null, "dropped at once");
  const b = await live();
  assert.equal(await feat(b.id), null, "no take-over while Pepe is featured");
  await upd(a.key, a.cid); await upd(b.key, b.cid);
  await S.tick();
  assert.deepEqual(await featuredIn(rooms.HOUSE_ROOM), []);
  // a pad owner can still feature a slot by hand
  await S.featureByOwner(b.id, "owner");
  assert.equal(await feat(b.id), "owner");
  await S.unfeature(b.id, "owner", "test");
  // the window ends -> auto-feature again (the earliest live, a - its auto-feature was dropped by the system, not cancelled)
  adv(10 * 60000 + 1000);
  await upd(a.key, a.cid); await upd(b.key, b.cid);
  assert.equal(S.pepeFeatured(), null);
  assert.equal(S.pepeSource().featured, false);
  await S.tick();
  assert.equal(await feat(a.id), "auto");
});

test("Pepe featured until turned off, and scheduled windows (from / until); bad windows are refused", async () => {
  await S.setPepeFeature({}, "admin1");
  assert.ok(S.pepeFeatured());
  assert.equal(S.config().pepe_feature.until, null, "until turned off");
  adv(40 * 86400000);
  assert.ok(S.pepeFeatured(), "still on");
  await S.setPepeFeature({ on: false }, "admin1");
  assert.equal(S.pepeFeatured(), null);
  assert.equal(S.config().pepe_feature, null);
  // scheduled: from in an hour, for 2 hours
  await S.setPepeFeature({ from: T + 3600000, minutes: 120 }, "admin1");
  assert.equal(S.pepeFeatured(), null, "not yet");
  const a = await live();
  assert.equal(await feat(a.id), "auto");
  adv(3600000 + 1000);
  assert.ok(S.pepeFeatured());
  await upd(a.key, a.cid);
  await S.tick();
  assert.equal(await feat(a.id), null, "the event started: dropped");
  await S.setPepeFeature({ on: false }, "admin1");
  await assert.rejects(S.setPepeFeature({ minutes: 0 }, "x"), /1 minute/);
  await assert.rejects(S.setPepeFeature({ from: T + 7200000, until: T + 3600000 }, "x"), /after the start/);
  await assert.rejects(S.setPepeFeature({ until: "not a date" }, "x"), /time/);
  await assert.rejects(S.setPepeFeature({ minutes: 31 * 24 * 60 }, "x"), /30 days/);
  assert.equal(S.config().pepe_feature, null, "refusals change nothing");
});

test("a real feature wins: an owner featuring another slot moves it; when that one ends the auto-feature comes back", async () => {
  const a = await live();
  adv(1000);
  const b = await live();
  assert.equal(await feat(a.id), "auto");
  await S.featureByOwner(b.id, "padowner");
  assert.equal(await feat(b.id), "owner");
  assert.equal(await feat(a.id), null);
  assert.equal((await S.getSlot(a.id)).auto_off, 0, "yielding isn't a cancel");
  await S.tick();
  assert.equal(await feat(a.id), null, "no auto-feature beside a real one");
  await S.end(b.id, "owner_ended", "x");
  assert.equal(await feat(a.id), "auto");
});

test("toggle off: no take-over, an auto-feature that's up is dropped; the pad's own setting overrides the site's", async () => {
  const a = await live();
  assert.equal(await feat(a.id), "auto");
  await S.setConfig({ takeover_mode: "off" }, "admin1");
  await upd(a.key, a.cid);
  await S.tick();
  assert.equal(await feat(a.id), null);
  adv(1000);
  const b = await live();
  assert.equal(await feat(b.id), null);
  // the pad turns it on for itself
  const R = await rooms.setStage(rooms.HOUSE_ROOM, { takeover: "when_idle" }, "padowner", { maxSlots: 4, maxPrice: 0 });
  assert.equal(R.takeover, "when_idle");
  assert.equal(await S.takeoverModeFor(rooms.HOUSE_ROOM), "when_idle");
  await upd(a.key, a.cid); await upd(b.key, b.cid);
  await S.tick();
  assert.equal(await feat(a.id), "auto");
  // site on, pad off
  await S.setConfig({ takeover_mode: "when_idle" }, "admin1");
  await rooms.setStage(rooms.HOUSE_ROOM, { takeover: "off" }, "padowner", { maxSlots: 4, maxPrice: 0 });
  await upd(a.key, a.cid); await upd(b.key, b.cid);
  await S.tick();
  assert.deepEqual(await featuredIn(rooms.HOUSE_ROOM), []);
  // "" = back to the site's setting; junk = the site's setting too
  assert.equal((await rooms.setStage(rooms.HOUSE_ROOM, { takeover: "bogus" }, "padowner", { maxSlots: 4, maxPrice: 0 })).takeover, null);
});

test("admin cancel: the slot stays on, isn't auto-featured again; the next live stream may take over", async () => {
  const a = await live();
  assert.equal(await feat(a.id), "auto");
  const r = await S.cancelAutoFeature(a.id, "admin1");
  assert.equal(r.done, true);
  assert.equal(await feat(a.id), null);
  assert.equal((await S.getSlot(a.id)).auto_off, 1);
  await upd(a.key, a.cid);
  await S.tick();
  assert.equal(await feat(a.id), null, "not re-featured");
  assert.equal((await S.getSlot(a.id)).status, "active", "still on the stage");
  const b = await live();
  assert.equal(await feat(b.id), "auto");
  // the owner's ☆ Unfeature on an auto-feature is the same cancel
  await S.unfeature(b.id, "padowner", "the pad owner unfeatured it");
  assert.equal((await S.getSlot(b.id)).auto_off, 1);
  await S.tick();
  assert.deepEqual(await featuredIn(rooms.HOUSE_ROOM), []);
});

test("an embed slot (live the moment it opens) is auto-featured when booked", async () => {
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30, mode: "embed", embed: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(b.slot.status, "active");
  assert.equal(b.slot.featured, true);
  assert.equal(b.slot.feature_by, "auto");
});

test("dock3 1.99?? (owner item 5): Pepe's stream featured on ONE pad - that pad's auto-feature drops and stays off, other pads untouched; the page's ★ (pad_featured)", async (t) => {
  S._setPepeAir(() => true); t.after(() => S._setPepeAir(null));   // (dock3 review: it counts while his stream is on air - test/dock3-review-server.test.js)
  await S.setConfig({ pepe_feature_pads: {} }, "test");
  const a = await live();                                    // the house pad: auto-featured
  assert.equal(await feat(a.id), "auto");
  const r = await S.setPadPepeFeature(rooms.HOUSE_ROOM, true, "owner1");
  assert.deepEqual(r, { featured: true });
  assert.equal(await feat(a.id), null, "one featured stream per pad: the auto-feature yields");
  assert.ok(S.padPepeFeatured(rooms.HOUSE_ROOM), "featured here");
  assert.equal(S.padPepeFeatured("Some.Other.Room"), null, "not on another pad");
  assert.equal(S.pepeFeatured(), null, "not the site-wide event");
  let src = S.pepeSource(undefined, rooms.HOUSE_ROOM);
  assert.equal(src.featured, true); assert.equal(src.pad_featured, true);
  src = S.pepeSource(undefined, "Some.Other.Room");
  assert.equal(src.featured, false, "another pad's stage has no ★ on him"); assert.equal(src.pad_featured, false);
  assert.equal(S.pepeSource().pad_featured, false, "no pad asked: no pad feature");
  // while it stands, no auto-feature on THIS pad
  adv(5000); const b = await live(); await S.tick();
  assert.equal(await feat(b.id), null, "Pepe featured here: nothing auto-featured");
  assert.equal((await featuredIn(rooms.HOUSE_ROOM)).length, 0);
  assert.deepEqual(await S.setPadPepeFeature(rooms.HOUSE_ROOM, true, "owner1"), { featured: true, already: true });
  // off: auto-feature resumes at once
  assert.deepEqual(await S.setPadPepeFeature(rooms.HOUSE_ROOM, false, "owner1"), { featured: false });
  assert.equal(S.padPepeFeatured(rooms.HOUSE_ROOM), null);
  assert.equal((await featuredIn(rooms.HOUSE_ROOM)).length, 1, "a live stream is auto-featured again");
  const ev = await getQuery("SELECT what, actor, detail, room_id FROM stage_events WHERE what IN ('pepe_featured', 'pepe_unfeatured') ORDER BY ts");
  assert.ok(ev.some((e) => e.what === "pepe_featured" && e.actor === "owner1" && e.room_id === rooms.HOUSE_ROOM), "logged with the pad");
});

test("dock3 1.99??: precedence - a slot featured by hand clears the pad's Pepe feature; refused while Pepe is away (409); the route is the slot buttons' rule", async (t) => {
  S._setPepeAir(() => true); t.after(() => S._setPepeAir(null));
  await S.setConfig({ pepe_feature_pads: {} }, "test");
  const a = await live();
  await S.setPadPepeFeature(rooms.HOUSE_ROOM, true, "owner1");
  await S.featureByOwner(a.id, "owner1");
  assert.equal(await feat(a.id), "owner");
  assert.equal(S.padPepeFeatured(rooms.HOUSE_ROOM), null, "a slot featured by hand ends Pepe's feature here");
  assert.equal(S.config().pepe_feature_pads[rooms.HOUSE_ROOM], undefined);
  // Pepe in another room (bridge.pepeIn false): refused; a stored one is ignored until he is back
  const B = require(path.join(repo, "bridge"));
  B._rooms.set("Elsewhere.Room", { id: "Elsewhere.Room", name: "Elsewhere", updated: Date.now() + 3600 * 1000, members: [], mic: [] });
  try {
    await assert.rejects(S.setPadPepeFeature(rooms.HOUSE_ROOM, true, "owner1"), (e) => e.status === 409 && /isn't in this pad/.test(e.message));
    await S.setConfig({ pepe_feature_pads: { [rooms.HOUSE_ROOM]: { by: "owner1", at: T } } }, "test");
    assert.ok(S.padPepeFeatured(rooms.HOUSE_ROOM), "(dock3 review: a short absence - a bot restart, rejoining rooms - is held)");
    adv(61 * 1000);
    assert.equal(S.padPepeFeatured(rooms.HOUSE_ROOM), null, "stored, but ignored while he is away (past the hold)");
    assert.equal(S.pepeSource(undefined, rooms.HOUSE_ROOM).featured, false);
  } finally { B._rooms.delete("Elsewhere.Room"); }
  assert.ok(S.padPepeFeatured(rooms.HOUSE_ROOM), "back (nobody knows where he is - shown as before): it counts again");
  await S.setConfig({ pepe_feature_pads: {} }, "test");
  const src = fs.readFileSync(path.join(repo, "mainstage.js"), "utf8");
  assert.match(src, /app\.post\("\/api\/stage\/pepe\/feature", addUser, needUser, async/);
  assert.match(src, /if \(!\(await rooms\.canManage\(req\.user, R\.id\)\)\) throw new Refuse\(403, "Only this pad's owner can feature streams\."\);/);
  // a bad stored value is cleaned
  await S.setConfig({ pepe_feature_pads: { "": { by: "x" }, ok: "nope", [rooms.HOUSE_ROOM]: { by: 7, at: "x" } } }, "test");
  assert.deepEqual(S.config().pepe_feature_pads, { [rooms.HOUSE_ROOM]: { by: "7", at: null } });
  await S.setConfig({ pepe_feature_pads: {} }, "test");
});

test("admin routes + UI: pepe-feature / autofeature cancel are staff-only; the admin card, pad setting and ★ strings exist", async () => {
  const src = fs.readFileSync(path.join(repo, "mainstage.js"), "utf8");
  assert.match(src, /"\/api\/stage\/admin\/pepe-feature", addUser, needStaff/);
  assert.match(src, /"\/api\/stage\/admin\/autofeature\/cancel", addUser, needStaff/);
  const tpl = fs.readFileSync(path.join(repo, "views", "stageAdmin.ejs"), "utf8");
  assert.match(tpl, /id="featCard"/);
  assert.match(tpl, /name="takeover_mode"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "stage-admin.js"), "utf8");
  assert.match(js, /auto-featured \(live\)/);
  assert.match(js, /data-autocancel/);
  const pad = fs.readFileSync(path.join(repo, "views", "padSettings.ejs"), "utf8");
  assert.match(pad, /name="takeover"/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["pad.settings.takeover.label", "pad.settings.takeover.site", "pad.settings.takeover.when_idle", "pad.settings.takeover.off",
                   "pad.settings.takeover.hint", "js.stage.room.featured_auto", "js.stage.room.featured_auto_title"]) assert.ok(en[k], k);
  const room = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  assert.match(room, /_t\('js\.stage\.room\.featured_auto', 'featured while live'\)/);
  assert.equal(en["js.stage.room.featured_auto"], "featured while live");
});
