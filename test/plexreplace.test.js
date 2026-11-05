// plexreplace (owner 2026-11-05: "a one-step 'play this instead', which replaces the current title in a single request so the feature and the
// card carry straight over. Build it."): ▶ "Play this instead" end to end against the REAL media-control service (deploy/mediactl, a mocked
// Plex + a fake ffmpeg), like test/upnext-stage.test.js:
//   * ONE request: the old 📼 slot ends 'library_replaced', the new one opens featured - an auto-feature as PENDING (the "Coming up next" card
//     for the NEW title before its first frame), a hand feature as it was; a reader polling all through never sees the pad with nothing featured
//   * the multi-slot guard: another live stream on the pad never takes the feature in between (it would after a ⏹)
//   * events / history: 'ended' library_replaced, 'library' "replaced <id>", one 'featured' carried line, no 'unfeatured'; the play rows, the
//     control log's "replace" line; media-control runs the new title only
//   * who: whoever may start a play AND control what's on (its starter, the pad's owner, the library admins); anyone else gets control_denied
//     on a replace and the busy refusal (with what's on, can_replace false) on a plain play - and nothing stops
//   * every refusal before anything stops (a bad title, an unconfirmed price); the stream it replaces doesn't count against the encoder cap
//   * a 📼 QUEUE: replaced as a whole (the queue ends "replaced by"), and a queue can replace a single title; the queue watcher leaves the
//     new title alone
//   * a resume on a fresh slot (media-control forgot the stream) takes the old slot over the same way ('library_restart')
//   * the single-play watcher never acts on a session a replace took off while its look was on the way (its stop would cut the new title)
//   * Pepe's chat (plexchat.js op play mode replace) sends it as ONE request; a busy refusal tells Pepe whether a replace is allowed
//   TZ=UTC node --test test/plexreplace.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexreplace-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SECRET = "r".repeat(48);
const PLEX_TOKEN = "plex-token-never-in-a-page-5e1d0b";
process.env.MEDIACTL_SECRET = SECRET;
delete process.env.MEDIACTL_TLS_SHA256;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));
const conf = require(path.join(repo, "mediaconf"));
const L = require(path.join(repo, "medialib"));
const Q = require(path.join(repo, "mediaqueue"));
const golive = require(path.join(repo, "golive"));
const PC = require(path.join(repo, "plexchat"));
const M = require(path.join(repo, "deploy", "mediactl", "mediactl.js"));

// ── a Plex with three films and a show (season 1: 3 episodes) ──
const media = path.join(tmp, "media");
fs.mkdirSync(media, { recursive: true });
const FILE = path.join(media, "secret-library-path.mkv");
fs.writeFileSync(FILE, "x");
const DUR = 2400;
const EPS = [["911", 1, 1, "Pilot"], ["912", 1, 2, "Second"], ["913", 1, 3, "Third"]];
const brief = ([key, season, episode, title]) => ({ key, type: "episode", title, show: "The Show", season, episode, duration: DUR, show_key: "900", season_key: "901", poster: true });
const plex = {
  async search() { return []; },
  async item(key) {
    if (key === "900") return { key, type: "show", title: "The Show", episodes: EPS.map(brief) };
    const e = EPS.find((x) => x[0] === key);
    if (e) return { ...brief(e), file: FILE, width: 1920, height: 1080, hdr: false, audio: [], subs: [] };
    if (key === "500") return { key, type: "movie", title: "Charade", year: 1963, file: FILE, duration: 6780, audio: [], subs: [], poster: true };
    if (key === "501") return { key, type: "movie", title: "Night of the Living Dead", year: 1968, file: FILE, duration: 5760, audio: [], subs: [], poster: true };
    if (key === "502") return { key, type: "movie", title: "Carnival of Souls", year: 1962, file: FILE, duration: 4680, audio: [], subs: [], poster: false };
    const err = new Error("Not in the Plex library"); err.status = 404; throw err;
  },
  async poster() { return { type: "image/jpeg", body: Buffer.from([1]) }; },
};
const procs = [];
function fakeSpawn(cmd, args) {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.args = args;
  p.kill = () => { if (p.dead) return; p.dead = true; setImmediate(() => p.emit("exit", null, "SIGTERM")); };
  procs.push(p);
  return p;
}
// one encoder: a replace must not count the stream it replaces (needEncoder exceptRoom)
const mcfg = M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_MEDIA_ROOTS: media + path.sep, PLEX_TOKEN, MEDIACTL_MAX_STREAMS: "1" });
const mstreams = M.makeStreams(mcfg, plex, fakeSpawn, undefined, async () => null);
const { server } = M.makeServer(mcfg, { plex, streams: mstreams });

let T = Date.now();
S._setClock(() => T);
const adv = (ms) => { T += ms; };
let n = 0;
async function mkUser(cls = "pleb", balance = 0) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                 [id, "user" + n, "User " + n, cls, balance, "cf_user" + n]);
  return { userId: id, username: "user" + n, class: cls };
}
const ROOM = "Replace.Room";
const tick = () => new Promise((r) => setImmediate(r));
const last = () => procs[procs.length - 1];
const keyOf = (p) => { const url = p.args[p.args.length - 1]; return url.slice(S.RTMP_PUBLIC.length + 1); };
let cids = 0;
async function pub(key) { const cid = String(++cids); const r = await S.rtmpCallback({ call: "publish", app: "stage", name: key, addr: "1.2.3.4", clientid: cid }); return { status: r.status, cid, key }; }
const feat = async (id) => { const s = await S.getSlot(id); return s && s.featured ? s.feature_by : null; };
const VIEWER = { userId: "viewer-1", username: "viewer1", class: "pleb" };
const featured = async (viewer = VIEWER) => { S.clearCache(); return S.featuredOf(ROOM, viewer); };
const events = async (id, what) => (await getQuery("SELECT detail FROM stage_events WHERE slot_id = ? AND what = ? ORDER BY rowid", [id, what])).map((r) => r.detail);
const stageName = () => L.stageName(ROOM);
const ctlMark = async () => (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM media_controls"))[0].m;
const onEncoder = () => mstreams.get(stageName());
const openLib = async () => getQuery("SELECT * FROM stage_slots WHERE room_id = ? AND source = 'library' AND status IN ('waiting','active')", [ROOM]);
// a reader polling the pad's featured slot (a page's /api/stage) all through a replace: every look it got
function watchFeature() {
  const seen = [];
  let on = true;
  const loop = (async () => {
    while (on) {
      S.clearCache();
      const f = await S.featuredOf(ROOM, VIEWER);
      seen.push(f ? f.id + (f.live ? ":live" : f.next ? ":next" : ":held") : "none");
      await tick();
    }
  })();
  return { seen, stop: async () => { on = false; await loop; return seen; } };
}
let admin, owner;
async function clear() {
  for (const q of await getQuery("SELECT id FROM media_queues WHERE state IN ('active','starting')")) {
    await runQuery("UPDATE media_queues SET state = 'ended' WHERE id = ?", [q.id]);
  }
  await runQuery("DELETE FROM media_sessions");
  mstreams.stopAll();
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  L._keys.clear();
  await S.setConfig({ takeover_mode: "when_idle", pepe_feature: null, pepe_feature_pads: {} }, "test");
  await conf.set({ library_price: 0 }, "test");
  procs.length = 0;
  await tick();
}

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.MEDIACTL_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, email TEXT, discordId TEXT, twitchId TEXT, auto_source TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, idle_grace_min: 5, enabled: true }, "test");
  await L.init();
  require(path.join(repo, "shop"));
  for (let i = 0; i < 100 && !(await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'shop_order_events'")).length; i++) await new Promise((r) => setTimeout(r, 20));
  admin = await mkUser("Admin");
  owner = await mkUser();
  await rooms.addRoom(ROOM, "Replace Pad", "test");
  await runQuery("UPDATE rooms_registry SET owner_kind = 'user', owner_user_id = ? WHERE room_id = ?", [owner.userId, ROOM]);
  await rooms.loadCache();
  await rooms.setStage(ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  // upnext2: these tests are about the start itself - the 📼 station break (on by default, 8 s) has its own (test/upnext-break.test.js)
  await conf.set({ library_enabled: true, library_break: false, library_plex: true, library_price: 0, library_daily_cap: 50, library_free_daily_cap: 50, library_queue_announce_min: 20 }, "test");
  golive.nowPlaying = async () => ({ announced: true });          // counted, not sent
});
test.afterEach(clear);
test.after(() => { mstreams.stopAll(); server.close(); });

test("▶ Play this instead: ONE request - the old slot ends 'library_replaced', the new one is featured PENDING with the card for the new title; never a moment with nothing featured", async () => {
  const c0 = await ctlMark();
  const p0 = (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM media_plays"))[0].m;
  const a = await L.play(admin, { room: ROOM, key: "500" });
  const pa = await pub(keyOf(last()));
  assert.equal(pa.status, 302);
  assert.equal(await feat(a.slot.id), "auto");
  const oldProc = last();
  adv(5000);
  const w = watchFeature();
  const r = await L.playFor(admin, { room: ROOM, key: "501", replace: true });
  const seen = await w.stop();
  assert.equal(r.ok, true);
  assert.deepEqual(r.replaced, { title: "Charade (1963)", queue: false, slot_id: a.slot.id, feature: "auto" });
  assert.ok(seen.length >= 2, "the reader looked all through (" + seen.length + " looks)");
  assert.ok(!seen.includes("none"), "never a look with nothing featured: " + JSON.stringify(seen));
  assert.ok(seen.every((x) => x === a.slot.id + ":live" || x === r.slot.id + ":next"), "only ever the old title live or the new one up next: " + JSON.stringify([...new Set(seen)]));
  // the old slot
  const so = await S.getSlot(a.slot.id);
  assert.deepEqual([so.status, so.settled, so.end_reason, so.ended_by, so.featured], ["ended", 1, "library_replaced", admin.username, 0]);
  assert.ok(oldProc.dead, "its encoder was stopped");
  // the new slot: open, featured auto, the card for the NEW title before its first frame
  const sn = await S.getSlot(r.slot.id);
  assert.deepEqual([sn.status, sn.featured, sn.feature_by], ["waiting", 1, "auto"]);
  const f = await featured();
  assert.equal(f.id, r.slot.id);
  assert.equal(f.live, false);
  assert.equal(f.next.title, "Night of the Living Dead");
  assert.equal(f.next.year, 1968);
  assert.equal(f.next.key, "501", "signed in: the poster's key");
  assert.equal(f.next.at, T, "the card's moment = the replace");
  const rs = await S.roomStage(ROOM, VIEWER);
  assert.equal(rs.featured.id, r.slot.id, "the pad page's first render names it too");
  assert.equal(rs.featured.next.title, "Night of the Living Dead");
  const blob = JSON.stringify([f, rs, await S.publicSlots(ROOM), await S.roomStage(ROOM, null), r]);
  for (const bad of [PLEX_TOKEN, FILE, "secret-library-path", process.env.MEDIACTL_URL]) assert.ok(!blob.includes(bad), "no " + bad);
  // events / history
  assert.deepEqual(await events(a.slot.id, "ended"), ["library_replaced: charged 0, refunded 0"]);
  assert.deepEqual(await events(a.slot.id, "unfeatured"), [], "the feature MOVED - it was never taken away");
  assert.deepEqual(await events(r.slot.id, "library"), [`📼 📼 Night of the Living Dead (1968) (${Math.ceil(5760 / 60) + 20} min max), replaced ${a.slot.id}`]);
  assert.deepEqual(await events(r.slot.id, "featured"), [`auto: 📼 up next - carried over from ${a.slot.id} (library_replaced)`]);
  // the plays, the session, the control log, media-control
  const plays = await getQuery("SELECT * FROM media_plays WHERE room_id = ? AND id > ? ORDER BY id", [ROOM, p0]);
  assert.equal(plays.length, 2);
  assert.equal(plays[0].end_reason, "replaced by " + admin.username);
  assert.ok(plays[0].ended_at);
  assert.equal(plays[1].slot_id, r.slot.id);
  assert.equal(plays[1].ended_at, null);
  const ss = await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [ROOM]);
  assert.deepEqual(ss.map((x) => [x.slot_id, x.title]), [[r.slot.id, "Night of the Living Dead (1968)"]]);
  const ctl = await getQuery("SELECT action, detail, username FROM media_controls WHERE room_id = ? AND id > ? ORDER BY id", [ROOM, c0]);
  assert.deepEqual(ctl, [{ action: "replace", detail: "Charade (1963) → Night of the Living Dead (1968)", username: admin.username }]);
  assert.equal(onEncoder().ratingKey, "501", "media-control runs the new title");
  assert.equal((await openLib()).length, 1, "one 📼 slot on the pad");
  // it publishes: live, the marker goes, still featured - featured once for its whole life
  const pb = await pub(keyOf(last()));
  assert.equal(pb.status, 302);
  assert.equal((await S.getSlot(r.slot.id)).upnext, null);
  const g = await featured();
  assert.deepEqual([g.id, g.live, g.next], [r.slot.id, true, undefined]);
  assert.equal((await events(r.slot.id, "featured")).length, 1);
  // the watcher leaves it alone
  await L.watch();
  assert.equal(onEncoder().ratingKey, "501");
  assert.equal((await S.getSlot(r.slot.id)).status, "active");
});

test("a hand feature carries as it was (the card shows for the new title) - and the multi-slot guard: a live stream beside it never takes the feature in between", async () => {
  const a = await L.play(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  await S.unfeature(a.slot.id, "system");
  await S.featureByOwner(a.slot.id, owner.username);
  assert.equal(await feat(a.slot.id), "owner");
  // another stream on the pad, live
  const u = await mkUser();
  const bk = await S.book(u, { minutes: 30, room: ROOM });
  assert.equal((await pub(bk.key)).status, 302);
  assert.equal(await feat(bk.slot.id), null, "the hand feature stays on the 📼 slot");
  const w = watchFeature();
  const r = await L.playFor(owner, { room: ROOM, key: "502", replace: true });
  const seen = await w.stop();
  assert.ok(!seen.includes("none") && !seen.some((x) => x.startsWith(bk.slot.id)), "never nothing, never the other stream: " + JSON.stringify([...new Set(seen)]));
  assert.equal(r.replaced.feature, "owner");
  assert.equal(await feat(r.slot.id), "owner", "featured by hand - as it was");
  assert.equal(await feat(bk.slot.id), null, "the other live stream didn't get it");
  const f = await featured();
  assert.deepEqual([f.id, f.live, f.by, f.next && f.next.title], [r.slot.id, false, "owner", "Carnival of Souls"]);
  assert.equal(f.next.poster, false, "no poster in Plex: the plain card");
  assert.deepEqual(await events(r.slot.id, "featured"), [`carried over from ${a.slot.id} (library_replaced, featured by owner)`]);
  // the next tick changes nothing (a hand feature waits for its stream)
  adv(5000);
  await S.autoFeature(ROOM);
  assert.equal(await feat(r.slot.id), "owner");
  assert.equal(await feat(bk.slot.id), null);
  await pub(keyOf(last()));
  assert.equal(await feat(r.slot.id), "owner");
});

test("the multi-slot guard (auto): a live stream on the pad doesn't take the feature during a replace - the card holds UPNEXT_MS - but it does after a ⏹", async () => {
  const a = await L.play(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  const u = await mkUser();
  const bk = await S.book(u, { minutes: 30, room: ROOM });
  const pk = await pub(bk.key);
  assert.equal(pk.status, 302);
  assert.equal(await feat(a.slot.id), "auto");
  assert.equal(await feat(bk.slot.id), null);
  const w = watchFeature();
  const r = await L.playFor(admin, { room: ROOM, key: "501", replace: true });
  const seen = await w.stop();
  assert.ok(!seen.some((x) => x === "none" || x.startsWith(bk.slot.id)), JSON.stringify([...new Set(seen)]));
  assert.equal(await feat(r.slot.id), "auto");
  assert.equal(await feat(bk.slot.id), null);
  adv(30000);
  await S.rtmpCallback({ call: "update_publish", app: "stage", name: pk.key, addr: "1.2.3.4", clientid: pk.cid });
  await S.autoFeature(ROOM);
  assert.equal(await feat(r.slot.id), "auto", "held while its title starts, the other stream live all along");
  assert.deepEqual(await events(bk.slot.id, "featured"), []);
  // control: ⏹ (no replace) - the live stream takes it at once
  await L.stop(admin, ROOM);
  assert.equal(await feat(bk.slot.id), "auto", "after a stop the other live stream is featured - the gap a replace never has");
});

test("who: the starter, the pad's owner and the library admins may replace; anyone else gets control_denied (replace) / busy with can_replace false (play) - and nothing stops", async () => {
  const alice = await mkUser();
  await conf.set({ library_users: alice.username }, "test");          // a Plex member (the override list): plays free
  const bob = await mkUser();                                          // a member of the site, no rights over alice's play
  try {
    const a = await L.playFor(alice, { room: ROOM, key: "500" });
    await pub(keyOf(last()));
    // bob: a plain play is busy (and says what's on, and that he may not replace it); a replace is control_denied; nothing stopped
    await assert.rejects(L.playFor(bob, { room: ROOM, key: "501" }), (e) => e.status === 409 && e.extra.code === "busy_library" && e.extra.can_replace === false &&
                         e.extra.playing === "Charade (1963)" && e.extra.playing_queue === false);
    await assert.rejects(L.playFor(bob, { room: ROOM, key: "501", replace: true }), (e) => e.status === 403 && e.extra.code === "control_denied" && e.extra.playing === "Charade (1963)");
    assert.equal((await S.getSlot(a.slot.id)).status, "active", "still on");
    assert.equal(onEncoder().ratingKey, "500");
    assert.equal(onEncoder().state, "playing");
    // the starter: a plain play says she may replace it; a replace goes through - her own 📼 slot isn't "you already have a stage slot"
    await assert.rejects(L.playFor(alice, { room: ROOM, key: "501" }), (e) => e.extra && e.extra.code === "busy_library" && e.extra.can_replace === true);
    const r1 = await L.playFor(alice, { room: ROOM, key: "501", replace: true });
    assert.equal(r1.replaced.title, "Charade (1963)");
    await pub(keyOf(last()));
    // the pad's owner (no Plex membership needed for control; free while library_price is 0)
    const r2 = await L.playFor(owner, { room: ROOM, key: "502", replace: true });
    assert.equal(r2.replaced.title, "Night of the Living Dead (1968)");
    assert.equal((await S.getSlot(r2.slot.id)).userId, owner.userId, "the new play is the replacer's");
    // the library admin
    const r3 = await L.playFor(admin, { room: ROOM, key: "500", replace: true });
    assert.equal(r3.replaced.title, "Carnival of Souls (1962)");
    // padState / mine say so for Pepe and the sheet
    const st = await L.padState(bob, ROOM);
    assert.deepEqual([st.library.title, st.library.can_replace], ["Charade (1963)", false]);
    assert.equal((await L.padState(owner, ROOM)).library.can_replace, true);
    assert.equal((await L.mine(bob, ROOM)).on_pad.can_replace, false);
    assert.deepEqual((await L.mine(admin, ROOM)).on_pad, { title: "Charade (1963)", queue: false, left: 0, by: admin.username, mine: true, can_replace: true, slot_id: r3.slot.id,
                                                            can_after: true });   // (upnext2 E: "+ Add to the queue" behind a single title)
    // nothing on: a replace is an ordinary play
    await L.stop(admin, ROOM);
    const r4 = await L.playFor(bob, { room: ROOM, key: "501", replace: true });
    assert.equal(r4.ok, true);
    assert.equal(r4.replaced, undefined);
  } finally { await conf.set({ library_users: "" }, "test"); }
});

test("every refusal comes before anything stops: a title not in Plex, an unconfirmed price, too long for the pad; the stream it replaces doesn't count against the encoder cap", async () => {
  const payer = await mkUser("pleb", 1000000);
  const c0 = await ctlMark();
  const a = await L.playFor(payer, { room: ROOM, key: "500" });           // free while the price is 0
  await pub(keyOf(last()));
  await conf.set({ library_price: 1000 }, "test");
  await assert.rejects(L.playFor(payer, { room: ROOM, key: "777", replace: true }), (e) => e.status === 404 || e.status === 400 || e.status === 502);
  await assert.rejects(L.playFor(payer, { room: ROOM, key: "501", replace: true }), (e) => e.status === 400 && e.extra.code === "price" && e.extra.price === 2000);
  await assert.rejects(L.playFor(payer, { room: ROOM, key: "501", replace: true, price: 1000 }), (e) => e.status === 409 && e.extra.code === "price");
  for (const id of [a.slot.id]) assert.equal((await S.getSlot(id)).status, "active", "still on after each refusal");
  assert.equal(onEncoder().ratingKey, "500");
  assert.equal(await feat(a.slot.id), "auto");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM media_controls WHERE action = 'replace' AND id > ?", [c0]))[0].n, 0);
  // the price they confirmed: ONE encoder in all (MEDIACTL_MAX_STREAMS 1) and it is this pad's - the replace may use it
  const before = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [payer.userId]))[0].b;
  const r = await L.playFor(payer, { room: ROOM, key: "501", replace: true, price: 2000 });
  assert.equal(r.price, 2000);
  assert.equal((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [payer.userId]))[0].b, before - 2000, "held from the replacer");
  assert.equal(onEncoder().ratingKey, "501");
  // a plain play on another pad still finds every encoder in use
  const other = "Replace.Other";
  await rooms.addRoom(other, "Other Pad", "test");
  await rooms.loadCache();
  await assert.rejects(L.playFor(payer, { room: other, key: "502", price: 2000 }), (e) => e.status === 429 || e.status === 409);
});

test("a 📼 QUEUE is replaced as a whole (it ends 'replaced by'), a queue can replace a single title, and the queue watcher leaves the new title alone", async () => {
  const c0 = await ctlMark();
  const q = await Q.start(admin, { room: ROOM, key: "911", scope: "season" });
  await pub(keyOf(last()));
  assert.equal(await feat(q.slot.id), "auto");
  assert.equal((await L.padState(admin, ROOM)).library.left, 2);
  assert.deepEqual((await L.mine(admin, ROOM)).on_pad, { title: "The Show — S1E1 Pilot", queue: true, left: 2, by: admin.username, mine: true, can_replace: true, slot_id: q.slot.id,
                                                          can_add: true });   // (upnext2 E: its starter grows it)
  const w = watchFeature();
  const r = await L.playFor(admin, { room: ROOM, key: "501", replace: true });
  const seen = await w.stop();
  assert.ok(!seen.includes("none"), JSON.stringify([...new Set(seen)]));
  assert.deepEqual(r.replaced, { title: "The Show — S1E1 Pilot", queue: true, slot_id: q.slot.id, feature: "auto" });
  const qr = (await getQuery("SELECT * FROM media_queues WHERE id = ?", [q.queue_id]))[0];
  assert.deepEqual([qr.state, qr.end_reason], ["ended", "replaced by " + admin.username]);
  const so = await S.getSlot(q.slot.id);
  assert.deepEqual([so.status, so.end_reason], ["ended", "library_replaced"]);
  const qp = (await getQuery("SELECT end_reason FROM media_plays WHERE queue_id = ? ORDER BY id", [q.queue_id])).map((x) => x.end_reason);
  assert.deepEqual(qp, ["replaced by " + admin.username], "the queue's title on now closed as replaced");
  const f = await featured();
  assert.deepEqual([f.id, f.live, f.next.title], [r.slot.id, false, "Night of the Living Dead"]);
  // the watchers: the queue is over, the new single title plays on
  await L.watch();
  await Q.watchIdle();
  assert.equal(onEncoder().ratingKey, "501");
  assert.equal((await S.getSlot(r.slot.id)).status, "waiting");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM media_plays WHERE queue_id = ?", [q.queue_id]))[0].n, 1, "the queue never moved on to its next title");
  await pub(keyOf(last()));
  // ...and a queue replacing a single title: its first episode is up next on the carried feature
  const r2 = await Q.startFor(admin, { room: ROOM, key: "912", scope: "season_rest", replace: true });
  assert.deepEqual(r2.replaced, { title: "Night of the Living Dead (1968)", queue: false, slot_id: r.slot.id, feature: "auto" });
  assert.equal(r2.items, 2);
  assert.equal((await S.getSlot(r.slot.id)).end_reason, "library_replaced");
  const g = await featured();
  assert.deepEqual([g.id, g.live, g.next.title, g.next.episode], [r2.slot.id, false, "Second", 2]);
  assert.equal(onEncoder().ratingKey, "912");
  assert.deepEqual((await getQuery("SELECT action, detail FROM media_controls WHERE action = 'replace' AND id > ? ORDER BY id", [c0])).map((x) => x.detail),
                   ["The Show — S1E1 Pilot → Night of the Living Dead (1968)", "Night of the Living Dead (1968) → The Show — S1E2 Second"]);
});

test("a resume on a fresh slot (media-control forgot the stream) takes the old slot over: its feature and the card carry ('library_restart')", async () => {
  const a = await L.play(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  assert.equal(await feat(a.slot.id), "auto");
  mstreams.stopAll();                                                  // media-control restarted: it forgot the stream
  const w = watchFeature();
  const r = await L.seek(admin, ROOM, 600);
  const seen = await w.stop();
  assert.equal(r.same_slot, false);
  assert.ok(!seen.includes("none"), JSON.stringify([...new Set(seen)]));
  const so = await S.getSlot(a.slot.id);
  assert.deepEqual([so.status, so.end_reason, so.ended_by], ["ended", "library_restart", admin.username]);
  const f = await featured();
  assert.deepEqual([f.id === a.slot.id, f.live, f.next && f.next.title], [false, false, "Charade"]);
  assert.equal(await feat(f.id), "auto");
  assert.deepEqual(await events(f.id, "featured"), [`auto: 📼 up next - carried over from ${a.slot.id} (library_restart)`]);
  assert.equal(onEncoder().offset, 600);
  const p = (await getQuery("SELECT carried_from FROM media_plays WHERE slot_id = ?", [f.id]))[0];
  assert.ok(p.carried_from, "the play carries the first one");
});

test("the single-play watcher never acts on a session a replace took off while its look was on the way (its stop would cut the new title)", async () => {
  const a = await L.play(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  const real = S.getSlot;
  let r = null, hooked = false;
  S.getSlot = async (id) => {
    if (!hooked && id === a.slot.id) {                                // the watcher's look at the OLD slot: the replace lands right now
      hooked = true;
      r = await L.playFor(admin, { room: ROOM, key: "501", replace: true });
    }
    return real(id);
  };
  try { await L.watch(); } finally { S.getSlot = real; }
  assert.ok(hooked && r && r.ok, "the replace ran during the watcher's look");
  assert.equal(onEncoder() && onEncoder().ratingKey, "501", "the new title's encoder is still on");
  assert.equal(onEncoder().state, "playing");
  assert.equal((await S.getSlot(r.slot.id)).status, "waiting", "and its slot");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM media_sessions WHERE slot_id = ?", [r.slot.id]))[0].n, 1);
});

test("the routes the sheet calls: POST /api/medialib/play answers a busy pad with can_replace + what's on; {replace: true} swaps it; /mine names it (on_pad)", async () => {
  const express = require(path.join(repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  const who = { [admin.userId]: admin, [owner.userId]: owner };
  const addUser = (req, res, next) => { req.user = who[req.headers["x-u"]] || null; next(); };
  L.register(app, { addUser, noTimers: true });
  const srv = await new Promise((ok) => { const x = app.listen(0, "127.0.0.1", () => ok(x)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const post = async (u, url, body) => { const r = await fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", "x-u": u.userId }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  const get = async (u, url) => (await fetch(base + url, { headers: { "x-u": u.userId } })).json();
  try {
    const a = await L.play(admin, { room: ROOM, key: "500" });
    await pub(keyOf(last()));
    const m = await get(owner, "/api/medialib/mine?room=" + encodeURIComponent(ROOM));
    assert.deepEqual(m.on_pad, { title: "Charade (1963)", queue: false, left: 0, by: admin.username, mine: false, can_replace: true, slot_id: a.slot.id, can_after: true },
                     "the pad's owner may change it (upnext2 E: and add behind it)");
    let r = await post(owner, "/api/medialib/play", { room: ROOM, key: "501" });
    assert.equal(r.status, 409);
    assert.deepEqual([r.j.ok, r.j.code, r.j.can_replace, r.j.playing, r.j.playing_queue], [false, "busy_library", true, "Charade (1963)", false]);
    r = await post(owner, "/api/medialib/play", { room: ROOM, key: "501", replace: true });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.replaced, { title: "Charade (1963)", queue: false, slot_id: a.slot.id, feature: "auto" });
    assert.equal((await S.getSlot(a.slot.id)).end_reason, "library_replaced");
    assert.equal((await featured()).next.title, "Night of the Living Dead");
    const blob = JSON.stringify([m, r.j]);
    for (const bad of [PLEX_TOKEN, FILE, process.env.MEDIACTL_URL]) assert.ok(!blob.includes(bad), "no " + bad);
  } finally { srv.close(); }
});

test("Pepe's chat: op play mode replace is ONE request (the feature carries); a busy refusal tells Pepe whether a replace is allowed", async () => {
  const alice = await mkUser();
  const bob = await mkUser();
  await conf.set({ library_users: alice.username }, "test");
  try {
    let r = await PC.handle({ op: "play", as: { user_id: alice.userId }, room: ROOM, key: "500", scope: "title", via: "room" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const s0 = (await openLib())[0];
    await pub(keyOf(last()));
    r = await PC.handle({ op: "play", as: { user_id: bob.userId }, room: ROOM, key: "501", scope: "title", via: "room" });
    assert.deepEqual([r.ok, r.code, r.can_replace, r.playing], [false, "busy_library", false, "Charade (1963)"]);
    r = await PC.handle({ op: "play", as: { user_id: bob.userId }, room: ROOM, key: "501", scope: "title", mode: "replace", via: "room" });
    assert.deepEqual([r.ok, r.code], [false, "control_denied"]);
    r = await PC.handle({ op: "play", as: { user_id: alice.userId }, room: ROOM, key: "501", scope: "title", via: "room" });
    assert.deepEqual([r.ok, r.code, r.can_replace], [false, "busy_library", true]);
    const st = await PC.handle({ op: "search", as: { user_id: alice.userId }, room: ROOM, q: "night", via: "room" });
    assert.equal(st.state.library.can_replace, true);
    r = await PC.handle({ op: "play", as: { user_id: alice.userId }, room: ROOM, key: "501", scope: "title", mode: "replace", via: "room" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.title, r.queue, r.replaced], ["Night of the Living Dead (1968)", false, { title: "Charade (1963)", queue: false }]);
    assert.equal((await S.getSlot(s0.id)).end_reason, "library_replaced");
    const f = await featured();
    assert.equal(f.next.title, "Night of the Living Dead");
    const audit = (await getQuery("SELECT detail FROM media_controls WHERE action = 'pepe' ORDER BY id")).map((x) => x.detail);
    assert.match(audit[audit.length - 1], /instead play 501 -> Night of the Living Dead \(1968\)/);
    // an episode through Pepe is a one-title queue: replace works there too
    r = await PC.handle({ op: "play", as: { user_id: alice.userId }, room: ROOM, key: "911", scope: "episode", mode: "replace", via: "room" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.queue, r.replaced], [true, { title: "Night of the Living Dead (1968)", queue: false }]);
  } finally { await conf.set({ library_users: "" }, "test"); }
});

// ── review fixes (the race + perms reviews of the plexreplace build) ──
// hold the next media-control request matching `re` ("METHOD /path") until released - a control "in flight"
function holdMediactl(re) {
  const orig = server.listeners("request");
  let held = null, release = null;
  const gate = new Promise((ok) => { release = ok; });
  server.removeAllListeners("request");
  server.on("request", async (req, res) => {
    if (!held && re.test(req.method + " " + req.url)) { held = req.method + " " + req.url; await gate; }
    for (const f of orig) f.call(server, req, res);
  });
  return { held: () => held, release: () => release(), restore() { release(); server.removeAllListeners("request"); for (const f of orig) server.on("request", f); } };
}
const until = async (fn, ms = 3000) => { for (let i = 0; i < ms / 5 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;

test("a replace names what it replaces (replace: <its slot id>): what's on changed -> replace_changed (what's on now) and nothing stops; two controllers at once -> ONE swap, the other is asked again; the target ended with nothing on -> an ordinary play", async () => {
  const alice = await mkUser(), bob = await mkUser();
  await conf.set({ library_users: alice.username + "," + bob.username }, "test");
  try {
    const a = await L.playFor(alice, { room: ROOM, key: "500" });
    await pub(keyOf(last()));
    // the sheet, Pepe and the busy refusal carry the slot a replace would take off - for someone who may replace it
    assert.equal((await L.mine(owner, ROOM)).on_pad.slot_id, a.slot.id);
    assert.equal((await L.padState(owner, ROOM)).library.slot_id, a.slot.id);
    await assert.rejects(L.playFor(owner, { room: ROOM, key: "501" }), (e) => e.extra.code === "busy_library" && e.extra.playing_slot === a.slot.id);
    assert.equal((await L.mine(bob, ROOM)).on_pad.slot_id, undefined, "may not replace: no slot id");
    assert.equal((await L.padState(bob, ROOM)).library.slot_id, undefined);
    await assert.rejects(L.playFor(bob, { room: ROOM, key: "501" }), (e) => e.extra.code === "busy_library" && e.extra.playing_slot === undefined);
    // race review A: two controllers both confirmed "instead of Charade" - ONE swap; the other is refused with what's on now (asked again)
    const rs = await Promise.allSettled([L.playFor(admin, { room: ROOM, key: "502", replace: a.slot.id }),
                                         L.playFor(owner, { room: ROOM, key: "501", replace: a.slot.id })]);
    const won = rs.find((x) => x.status === "fulfilled"), lost = rs.find((x) => x.status === "rejected");
    assert.ok(won && lost, "one swap, one refusal: " + JSON.stringify(rs.map((x) => x.status === "fulfilled" ? "ok" : x.reason.message)));
    assert.equal(won.value.replaced.title, "Charade (1963)");
    const e = lost.reason;
    assert.deepEqual([e.status, e.extra.code, e.extra.can_replace, e.extra.playing, e.extra.playing_queue, e.extra.playing_slot],
                     [409, "replace_changed", true, won.value.title, false, won.value.slot.id]);
    const adminWon = won === rs[0];
    assert.equal(onEncoder().ratingKey, adminWon ? "502" : "501", "the first swap's title plays on");
    assert.equal((await S.getSlot(won.value.slot.id)).status, "waiting", "...and its slot");
    assert.equal(await feat(won.value.slot.id), "auto");
    assert.equal((await openLib()).length, 1);
    // asked again with what's on now: it goes through
    const who2 = adminWon ? owner : admin;
    const r2 = await L.playFor(who2, { room: ROOM, key: "500", replace: won.value.slot.id });
    assert.equal(r2.replaced.title, won.value.title);
    await pub(keyOf(last()));
    // perms review PROBE 1 (stale consent): confirmed "instead of <r2>", but r2 stopped and bob started his own - the yes never takes bob's off
    await L.stop(who2, ROOM);
    const b = await L.playFor(bob, { room: ROOM, key: "502" });
    await pub(keyOf(last()));
    await assert.rejects(L.playFor(owner, { room: ROOM, key: "501", replace: r2.slot.id }),
                         (x) => x.status === 409 && x.extra.code === "replace_changed" && x.extra.playing === "Carnival of Souls (1962)" && x.extra.playing_slot === b.slot.id);
    assert.equal((await S.getSlot(b.slot.id)).status, "active", "bob's title plays on");
    assert.equal(onEncoder().ratingKey, "502");
    // Pepe's op carries it the same way (replace_slot) and hears the refusal's fields
    const pc = await PC.handle({ op: "play", as: { user_id: owner.userId }, room: ROOM, key: "501", scope: "title", mode: "replace", replace_slot: r2.slot.id, via: "room" });
    assert.deepEqual([pc.ok, pc.code, pc.can_replace, pc.playing, pc.playing_slot], [false, "replace_changed", true, "Carnival of Souls (1962)", b.slot.id]);
    const pc2 = await PC.handle({ op: "play", as: { user_id: owner.userId }, room: ROOM, key: "501", scope: "title", mode: "replace", replace_slot: b.slot.id, via: "room" });
    assert.deepEqual([pc2.ok, pc2.replaced && pc2.replaced.title], [true, "Carnival of Souls (1962)"]);
    // the target ended and nothing is on: an ordinary play
    await L.stop(owner, ROOM);
    const r3 = await L.playFor(alice, { room: ROOM, key: "500", replace: b.slot.id });
    assert.equal(r3.ok, true);
    assert.equal(r3.replaced, undefined);
    // a 📼 queue that moved on to its next title keeps its slot - a replace aimed at it still goes through
    await L.stop(alice, ROOM);
    const q = await Q.start(admin, { room: ROOM, key: "911", scope: "season" });
    await pub(keyOf(last()));
    await Q.next(admin, ROOM);
    assert.equal((await L.mine(admin, ROOM)).on_pad.title, "The Show — S1E2 Second");
    const r4 = await L.playFor(admin, { room: ROOM, key: "501", replace: q.slot.id });
    assert.deepEqual([r4.replaced.title, r4.replaced.queue], ["The Show — S1E2 Second", true]);
  } finally { await conf.set({ library_users: "" }, "test"); }
});

test("the single-play controls hold the pad's lock: a ⏹ / pause in flight when a replace comes finishes first; a ⏹ / pause authorised on the OLD play that lands after a replace never touches the new one", async () => {
  const alice = await mkUser();
  await conf.set({ library_users: alice.username }, "test");
  let h = null;
  try {
    // perms review PROBE 2b: alice's ⏹ is at media-control when the owner's replace (confirmed "instead of Charade") comes
    const a = await L.playFor(alice, { room: ROOM, key: "500" });
    await pub(keyOf(last()));
    h = holdMediactl(/^POST \/streams\/.*\/stop$/);
    const p = L.stop(alice, ROOM);
    await until(() => h.held());
    assert.ok(h.held(), "alice's stop reached media-control");
    const rp = L.playFor(owner, { room: ROOM, key: "501", replace: a.slot.id });
    await sleep(50);
    h.release();
    await p;
    const r = await rp;
    h.restore(); h = null;
    assert.equal(r.ok, true);
    assert.equal(r.replaced, undefined, "the stop came first: nothing left to replace - an ordinary play");
    assert.equal((await S.getSlot(a.slot.id)).end_reason, "library_stopped");
    assert.equal(onEncoder() && onEncoder().ratingKey + "/" + onEncoder().state, "501/playing", "the new title's encoder is on - alice's ⏹ never reached it");
    assert.equal((await S.getSlot(r.slot.id)).status, "waiting");
    assert.equal((await featured()).id, r.slot.id);
    await pub(keyOf(last()));
    // the other order: the replace is mid-way (its stop of the old title held at media-control) when a ⏹ / pause authorised on the OLD play comes
    await L.stop(owner, ROOM);
    const a2 = await L.playFor(alice, { room: ROOM, key: "500" });
    await pub(keyOf(last()));
    h = holdMediactl(/^POST \/streams\/.*\/stop$/);
    const rp2 = L.playFor(owner, { room: ROOM, key: "502", replace: a2.slot.id });
    await until(() => h.held());
    assert.ok(h.held(), "the replace is stopping the old title");
    const sp = L.stop(alice, ROOM).then(() => "stopped", (x) => x);
    const pp = L.pause(alice, ROOM).then(() => "paused", (x) => x);
    await sleep(50);
    h.release();
    const r2 = await rp2;
    const se = await sp, pe = await pp;
    h.restore(); h = null;
    for (const x of [se, pe]) assert.ok(x instanceof Error && x.status === 409 && x.extra && x.extra.code === "play_changed", "refused: " + (x && (x.message || x)));
    assert.equal(onEncoder() && onEncoder().ratingKey + "/" + onEncoder().state, "502/playing", "the new title plays on - not stopped, not paused");
    assert.equal((await S.getSlot(r2.slot.id)).status, "waiting");
    assert.deepEqual((await getQuery("SELECT slot_id, state FROM media_sessions WHERE room_id = ?", [ROOM])).map((x) => [x.slot_id, x.state]), [[r2.slot.id, "playing"]]);
    // a pause in flight when a replace comes: the replace waits, then swaps the (paused) title for a playing one
    await pub(keyOf(last()));
    h = holdMediactl(/^POST \/streams\/.*\/pause$/);
    const pz = L.pause(owner, ROOM);
    await until(() => h.held());
    assert.ok(h.held(), "the pause reached media-control");
    const rp3 = L.playFor(owner, { room: ROOM, key: "500", replace: r2.slot.id });
    await sleep(50);
    h.release();
    await pz;
    const r3 = await rp3;
    h.restore(); h = null;
    assert.equal(r3.replaced.title, "Carnival of Souls (1962)");
    assert.equal(onEncoder().ratingKey + "/" + onEncoder().state, "500/playing", "the pause landed on the old title, not the new one");
    assert.deepEqual((await getQuery("SELECT state FROM media_sessions WHERE room_id = ?", [ROOM])).map((x) => x.state), ["playing"]);
  } finally { if (h) h.restore(); await conf.set({ library_users: "" }, "test"); }
});

test("the single-play watcher holds the pad's lock: a replace that lands after its re-check (the old title just ended in media-control) waits for it - the watcher never cuts the new title", async () => {
  const a = await L.play(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  mstreams._streams.get(stageName()).state = "ended";               // the credits rolled; the watcher's look sees it
  const realEnd = S.end;
  let rp = null;
  S.end = async (id, reason, actor) => {
    if (!rp && id === a.slot.id) {                                     // race review D: the replace comes right after the watcher's re-check
      rp = L.playFor(admin, { room: ROOM, key: "501", replace: a.slot.id });
      await Promise.race([rp.catch(() => {}), sleep(1000)]);           // (it finishes now - or waits for the watcher's lock)
    }
    return realEnd(id, reason, actor);
  };
  try { await L.watch(); } finally { S.end = realEnd; }
  const r = await rp;
  assert.equal(r.ok, true);
  assert.equal(onEncoder() && onEncoder().ratingKey + "/" + onEncoder().state, "501/playing", "the new title's encoder is on");
  assert.equal((await S.getSlot(a.slot.id)).end_reason, "library_done", "the old title ended as it did");
  assert.equal((await S.getSlot(r.slot.id)).status, "waiting");
  assert.equal((await featured()).id, r.slot.id, "the new title is the pad's featured stage (its card)");
  await L.watch();
  assert.equal((await S.getSlot(r.slot.id)).status, "waiting", "the next look leaves it alone (not library_lost)");
  assert.equal(onEncoder().ratingKey, "501");
});

test("media-control refusing the new title after the swap (the known limit): the old title is off ('library_replaced'), the new slot ends 'library_failed', the PAT comes back - and the feature moves on to the other live stream", async () => {
  const payer = owner;                                               // (the pad's owner: may control the admin's play, pays like anyone)
  await runQuery("UPDATE users SET points_balance = 1000000 WHERE userId = ?", [owner.userId]);
  const a = await L.play(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  const u = await mkUser();
  const bk = await S.book(u, { minutes: 30, room: ROOM });
  await pub(bk.key);
  assert.equal(await feat(a.slot.id), "auto");
  await conf.set({ library_price: 1000 }, "test");
  const b0 = await bal(payer);
  const had = new Set((await getQuery("SELECT id FROM stage_slots WHERE room_id = ?", [ROOM])).map((x) => x.id));
  const realStart = mstreams.start;
  mstreams.start = async function (stage, b) { if (String(b.ratingKey) === "501") { const e = new Error("the encoder refused"); e.status = 500; throw e; } return realStart.call(this, stage, b); };
  let err = null;
  try { await L.playFor(payer, { room: ROOM, key: "501", replace: a.slot.id, price: 2000 }); } catch (e) { err = e; } finally { mstreams.start = realStart; }
  assert.ok(err, "refused");
  assert.equal(err.status, 502);
  assert.match(err.message, /refunded/i);
  assert.equal((await S.getSlot(a.slot.id)).end_reason, "library_replaced", "the old title is off - the swap happened");
  assert.equal(onEncoder(), null, "no encoder on the pad");
  const nw = (await getQuery("SELECT id, status, end_reason FROM stage_slots WHERE room_id = ? AND source = 'library'", [ROOM])).filter((x) => !had.has(x.id));
  assert.deepEqual(nw.map((x) => [x.status, x.end_reason]), [["ended", "library_failed"]]);
  assert.equal(await bal(payer), b0, "the held PAT came back");
  assert.equal(await feat(bk.slot.id), "auto", "the other live stream has the pad's feature");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM media_sessions WHERE room_id = ?", [ROOM]))[0].n, 0);
  assert.equal((await getQuery("SELECT end_reason FROM media_plays WHERE slot_id = ?", [a.slot.id]))[0].end_reason, "replaced by " + payer.username);
});

test("an auto-feature carried as PENDING whose new title never publishes: held UPNEXT_MS, then the other live stream takes it (the hold isn't forever)", async () => {
  const a = await L.play(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  const u = await mkUser();
  const bk = await S.book(u, { minutes: 30, room: ROOM });
  const pk = await pub(bk.key);
  const r = await L.playFor(admin, { room: ROOM, key: "501", replace: a.slot.id });
  assert.equal(await feat(r.slot.id), "auto");
  adv(60000);
  await S.rtmpCallback({ call: "update_publish", app: "stage", name: pk.key, addr: "1.2.3.4", clientid: pk.cid });
  await S.autoFeature(ROOM);
  assert.equal(await feat(r.slot.id), "auto", "60 s: still held for the title that is starting");
  adv(31000);
  await S.rtmpCallback({ call: "update_publish", app: "stage", name: pk.key, addr: "1.2.3.4", clientid: pk.cid });
  await S.autoFeature(ROOM);
  assert.equal(await feat(bk.slot.id), "auto", "past UPNEXT_MS: the live stream has it");
  assert.equal(await feat(r.slot.id), null);
});
