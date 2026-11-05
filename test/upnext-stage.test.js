// upnext (owner 2026-11-05: "Yes up next card sounds good. Do it a classic / retro Public Access tv style."): the SERVER half of the 📼
// "Coming up next" card, end to end against the REAL media-control service (deploy/mediactl, a mocked Plex + a fake ffmpeg) like
// test/mediaqueue.test.js:
//   * ⏹ then ▶ (every gap prod saw): the new library slot is the pad's featured stage the moment it opens - before its first frame -
//     with what's starting (featuredOf / roomStage `next`), and the marker goes when the stream publishes
//   * a 📼 queue moving on: the same slot, still featured, names its next title until it publishes; a 📼 pause names nothing
//   * UPNEXT_MS (90 s): held until then, whatever else went live; past it the feature is let go (mic follows / Pepe's stream) - a late
//     publish gets it back; a retried title keeps its first moment
//   * never over a real feature: takeover off, Pepe's stream featured, a slot featured by hand, a live auto-featured stream (which hands
//     it to the 📼 slot when it ends)
//   * no Plex URL / token / file path in anything a page gets
//   node --test test/upnext-stage.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upnext-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SECRET = "u".repeat(48);
const PLEX_TOKEN = "plex-token-never-in-a-page-7f3a9c";
process.env.MEDIACTL_SECRET = SECRET;
delete process.env.MEDIACTL_TLS_SHA256;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));
const conf = require(path.join(repo, "mediaconf"));
const L = require(path.join(repo, "medialib"));
const Q = require(path.join(repo, "mediaqueue"));
const golive = require(path.join(repo, "golive"));
const M = require(path.join(repo, "deploy", "mediactl", "mediactl.js"));

// ── a Plex with two films and a show (season 1: 3 episodes) ──
let posterCalls = 0;
const media = path.join(tmp, "media");
fs.mkdirSync(media, { recursive: true });
const FILE = path.join(media, "secret-library-path.mkv");
fs.writeFileSync(FILE, "x");
const DUR = 2400;
const EPS = [["911", 1, 1, "Pilot"], ["912", 1, 2, "Second"], ["913", 1, 3, "Third"]];
const brief = ([key, season, episode, title]) => ({ key, type: "episode", title, show: "The Show", season, episode, duration: DUR, show_key: "900", season_key: "901", poster: key !== "913" });
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
  async poster() { posterCalls++; return { type: "image/jpeg", body: Buffer.from([1]) }; },
};
const procs = [];
function fakeSpawn(cmd, args) {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.args = args;
  p.kill = () => { if (p.dead) return; p.dead = true; setImmediate(() => p.emit("exit", null, "SIGTERM")); };
  procs.push(p);
  return p;
}
const mcfg = M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_MEDIA_ROOTS: media + path.sep, PLEX_TOKEN });
const mstreams = M.makeStreams(mcfg, plex, fakeSpawn, undefined, async () => null);
const { server } = M.makeServer(mcfg, { plex, streams: mstreams });

let T = Date.now();
S._setClock(() => T);
const adv = (ms) => { T += ms; };
let n = 0;
async function mkUser(cls = "pleb") {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, 0)", [id, "user" + n, "User " + n, cls]);
  return { userId: id, username: "user" + n, class: cls };
}
const ROOM = rooms.HOUSE_ROOM;
const tick = () => new Promise((r) => setImmediate(r));
const last = () => procs[procs.length - 1];
const keyOf = (p) => { const url = p.args[p.args.length - 1]; return url.slice(S.RTMP_PUBLIC.length + 1); };
let cids = 0;
async function pub(key) { const cid = String(++cids); const r = await S.rtmpCallback({ call: "publish", app: "stage", name: key, addr: "1.2.3.4", clientid: cid }); return { status: r.status, cid, key }; }
const done = (p) => S.rtmpCallback({ call: "publish_done", app: "stage", name: p.key, addr: "1.2.3.4", clientid: p.cid });
const beat = (p) => S.rtmpCallback({ call: "update_publish", app: "stage", name: p.key, addr: "1.2.3.4", clientid: p.cid });   // nginx-rtmp's 10 s heartbeat
async function playFor(sec) { last().stdout.write(`out_time_us=${Math.round(sec * 1e6)}\n`); await tick(); }
async function finish() { const p = last(); p.stdout.write(`out_time_us=${DUR * 1e6}\n`); await tick(); p.emit("exit", 0); await tick(); }
const feat = async (id) => { const s = await S.getSlot(id); return s && s.featured ? s.feature_by : null; };
// (upnext review privacy F1: a signed-in viewer - the poster's rating key is only theirs; signed out: featured(null))
const VIEWER = { userId: "viewer-1", username: "viewer1", class: "pleb" };
const featured = async (viewer = VIEWER) => { S.clearCache(); return S.featuredOf(ROOM, viewer); };
const events = async (id, what) => (await getQuery("SELECT detail FROM stage_events WHERE slot_id = ? AND what = ? ORDER BY rowid", [id, what])).map((r) => r.detail);
let admin;
async function clear() {
  for (const q of await getQuery("SELECT id FROM media_queues WHERE state IN ('active','starting')")) {
    await runQuery("UPDATE media_queues SET state = 'ended' WHERE id = ?", [q.id]);
  }
  await runQuery("DELETE FROM media_sessions");
  mstreams.stopAll();
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  L._keys.clear();
  await S.setConfig({ takeover_mode: "when_idle", pepe_feature: null, pepe_feature_pads: {} }, "test");
  procs.length = 0;
  await tick();
}

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.MEDIACTL_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, idle_grace_min: 5, enabled: true }, "test");
  await rooms.setStage(ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await L.init();
  require(path.join(repo, "shop"));
  for (let i = 0; i < 100 && !(await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'shop_order_events'")).length; i++) await new Promise((r) => setTimeout(r, 20));
  admin = await mkUser("Admin");
  // upnext2: these tests are about the start itself - the 📼 station break (on by default, 8 s) has its own (test/upnext-break.test.js)
  await conf.set({ library_enabled: true, library_break: false, library_plex: true, library_price: 0, library_daily_cap: 50, library_free_daily_cap: 50, library_queue_announce_min: 20 }, "test");
  golive.nowPlaying = async () => ({ announced: true });          // counted, not sent
});
test.afterEach(clear);
test.after(() => { mstreams.stopAll(); server.close(); });

test("⏹ then ▶ (prod's gaps): the new 📼 slot is featured before its first frame, with what's starting; its publish clears the marker", async () => {
  const a = await L.play(admin, { room: ROOM, key: "500" });
  const pa = await pub(keyOf(last()));
  assert.equal(pa.status, 302);
  assert.equal(await feat(a.slot.id), "auto");
  assert.equal((await featured()).next, undefined, "live: nothing is 'up next'");
  await L.stop(admin, ROOM);
  assert.equal(await featured(), null, "stopped: nothing featured (the gap)");
  const b = await L.play(admin, { room: ROOM, key: "501" });
  const sb = await S.getSlot(b.slot.id);
  assert.equal(sb.status, "waiting", "nothing has published yet");
  assert.equal(sb.featured, 1, "...and it is ALREADY the pad's featured stage - no tick gap");
  assert.equal(sb.feature_by, "auto");
  assert.deepEqual(await events(b.slot.id, "featured"), ["auto: 📼 up next while nothing else was featured"]);
  const f = await featured();
  assert.equal(f.id, b.slot.id);
  assert.equal(f.live, false);
  assert.equal(f.went, false);
  const { at, until, now: nowAt, ...rest } = f.next;
  assert.deepEqual(rest, { title: "Night of the Living Dead", kind: "movie", year: 1968, show: null, season: null, episode: null, poster: true, key: "501" });
  assert.equal(at, T);
  assert.equal(until - at, S.UPNEXT_MS);
  assert.equal(S.UPNEXT_MS, 90000);
  assert.equal(nowAt, T, "the server's clock with it (a page's first render has no poll `now` yet)");
  const rs = await S.roomStage(ROOM, VIEWER);
  assert.equal(rs.featured.id, b.slot.id, "roomStage (the pad page's first render) names it");
  assert.equal(rs.featured.next.key, "501", "signed in: the poster's key");
  assert.equal(rs.featured.next.title, "Night of the Living Dead");
  assert.deepEqual(rs.slots, [], "it isn't LISTED - it isn't live");
  // nothing a page gets carries the Plex token, the server's address, a file path or the encoder's
  const blob = JSON.stringify([f, rs, await S.publicSlots(ROOM), await S.featuredOf(ROOM, null, { front: true }), await S.roomStage(ROOM, null)]);
  for (const bad of [PLEX_TOKEN, FILE, "secret-library-path", process.env.MEDIACTL_URL, "X-Plex", "/library/metadata", "thumb"]) assert.ok(!blob.includes(bad), "no " + bad);
  // the stream publishes: the marker goes, the feature stays
  const pb = await pub(keyOf(last()));
  assert.equal(pb.status, 302);
  assert.equal((await S.getSlot(b.slot.id)).upnext, null);
  const g = await featured();
  assert.equal(g.live, true);
  assert.equal(g.next, undefined);
  assert.equal(await feat(b.slot.id), "auto");
  assert.deepEqual(await events(b.slot.id, "featured"), ["auto: 📼 up next while nothing else was featured"], "featured once - going live moved nothing");
  // a title with no poster: poster false, no key handed out
  await L.stop(admin, ROOM);
  const c = await L.play(admin, { room: ROOM, key: "502" });
  const h = await featured();
  assert.equal(h.id, c.slot.id);
  assert.equal(h.next.poster, false);
  assert.equal("key" in h.next, false, "no rating key without a poster to fetch");
});

test("a 📼 queue between two titles: the same slot stays featured and names its next title until it publishes; a 📼 pause names nothing", async () => {
  const r = await Q.start(admin, { room: ROOM, key: "911", scope: "season" });
  const p1 = await pub(keyOf(last()));
  assert.equal(p1.status, 302);
  assert.equal(await feat(r.slot.id), "auto");
  assert.equal((await featured()).next, undefined, "title 1 is on");
  await playFor(60); await L.watch();
  // title 1 ends: its publish drops, the watcher moves the queue on (the next ffmpeg starts - not published yet)
  await done(p1);
  await finish(); await L.watch();
  assert.equal(procs.length, 2, "the next title's encoder started");
  const f = await featured();
  assert.equal(f.id, r.slot.id, "the same slot");
  assert.equal(f.live, false);
  assert.equal(f.went, true);
  assert.equal(f.by, "auto");
  assert.deepEqual({ ...f.next, at: 0, until: 0, now: 0 }, { title: "Second", kind: "episode", year: null, show: "The Show", season: 1, episode: 2, poster: true, key: "912", at: 0, until: 0, now: 0 });
  assert.equal((await events(r.slot.id, "featured")).length, 1, "one featured event for the whole queue");
  assert.equal((await events(r.slot.id, "unfeatured")).length, 0);
  // it publishes: cleared
  const p2 = await pub(keyOf(last()));
  assert.equal(p2.status, 302);
  assert.equal((await featured()).next, undefined);
  assert.equal((await S.getSlot(r.slot.id)).upnext, null);
  // a 📼 pause (its ffmpeg stops) is a drop, not "up next"
  await playFor(30); await L.watch();
  await L.pause(admin, ROOM);
  await done(p2);
  const g = await featured();
  assert.equal(g.id, r.slot.id);
  assert.equal(g.live, false);
  assert.equal(g.next, undefined, "a pause never reads as up next");
});

test("UPNEXT_MS: held 90 s (89 s still featured), then let go - not cancelled: a late publish is featured again; a retried title keeps its first moment", async () => {
  const b = await L.play(admin, { room: ROOM, key: "501" });
  const t0 = T;
  assert.equal(await feat(b.slot.id), "auto");
  // the same title asked again 10 s later (a queue retrying it): its moment stays; another title starts its own
  adv(10000);
  assert.equal(await S.libraryUpNext(b.slot.id, { key: "501", kind: "movie", title: "Night of the Living Dead", year: 1968, poster: true }), true);
  assert.equal((await featured()).next.at, t0, "a retry never restarts the 90 s");
  adv(79000);                                                   // 89 s
  await S.autoFeature(ROOM);
  assert.equal(await feat(b.slot.id), "auto", "89 s: still the featured stage");
  assert.ok((await featured()).next, "89 s: still up next");
  adv(2000);                                                    // 91 s
  S.clearCache();
  assert.equal((await featured()).next, undefined, "91 s: no longer up next");
  await S.autoFeature(ROOM);
  assert.equal(await feat(b.slot.id), null, "91 s: let go - mic follows / Pepe's stream");
  assert.deepEqual(await events(b.slot.id, "unfeatured"), ["auto-feature: 📼 up next didn't start"]);
  assert.equal((await S.getSlot(b.slot.id)).auto_off, 0, "the system let it go - nobody said no");
  assert.equal(await featured(), null);
  await S.autoFeature(ROOM);
  assert.equal(await feat(b.slot.id), null, "an expired marker never features it again by itself");
  // it starts after all: featured again, as a live stream
  const p = await pub(keyOf(last()));
  assert.equal(p.status, 302);
  assert.equal(await feat(b.slot.id), "auto");
  assert.deepEqual((await events(b.slot.id, "featured")).slice(-1), ["auto: live while nothing else was featured"]);
  // a different title on the same slot is its own up next
  adv(5000);
  await done(p);
  assert.equal(await S.libraryUpNext(b.slot.id, { key: "500", kind: "movie", title: "Charade", year: 1963 }), true);
  assert.equal((await featured()).next.at, T);
  assert.equal((await featured()).next.title, "Charade");
});

test("never over a real feature: takeover off, Pepe's stream featured, a slot featured by hand; a live auto-featured stream keeps it, then hands it to the 📼 slot", async () => {
  // takeover off
  await S.setConfig({ takeover_mode: "off" }, "test");
  let b = await L.play(admin, { room: ROOM, key: "501" });
  assert.equal(await feat(b.slot.id), null, "takeover off");
  assert.equal(await featured(), null);
  await clear();
  // Pepe's stream featured (the site-wide event)
  await S.setPepeFeature({ minutes: 10 }, "admin1");
  b = await L.play(admin, { room: ROOM, key: "501" });
  assert.equal(await feat(b.slot.id), null, "Pepe's stream is featured");
  await clear();
  // a live slot featured by hand
  const u = await mkUser();
  const bk = await S.book(u, { minutes: 30, room: ROOM });
  assert.equal((await pub(bk.key)).status, 302);
  await S.unfeature(bk.slot.id, "system");                      // (it went live auto-featured: the owner features it by hand instead)
  await S.featureByOwner(bk.slot.id, "owner");
  b = await L.play(admin, { room: ROOM, key: "501" });
  assert.equal(await feat(b.slot.id), null, "a hand feature stays");
  assert.equal(await feat(bk.slot.id), "owner");
  await clear();
  // an auto-featured LIVE stream: live first - it keeps the feature; when it ends the 📼 slot that is starting gets it
  const u2 = await mkUser();
  const bk2 = await S.book(u2, { minutes: 30, room: ROOM });
  assert.equal((await pub(bk2.key)).status, 302);
  assert.equal(await feat(bk2.slot.id), "auto");
  b = await L.play(admin, { room: ROOM, key: "501" });
  assert.equal(await feat(b.slot.id), null, "a live stream beats one that is starting");
  assert.equal(await feat(bk2.slot.id), "auto");
  await S.end(bk2.slot.id, "ended_by_user", u2.username);
  assert.equal(await feat(b.slot.id), "auto", "the live one ended: the 📼 slot that is starting is featured at once");
  assert.equal((await featured()).next.title, "Night of the Living Dead");
});

test("a pending 📼 feature holds for its 90 s even when another stream goes live meanwhile, then that one takes over", async () => {
  const b = await L.play(admin, { room: ROOM, key: "501" });
  assert.equal(await feat(b.slot.id), "auto");
  adv(20000);
  const u = await mkUser();
  const bk = await S.book(u, { minutes: 30, room: ROOM });
  const pk = await pub(bk.key);
  assert.equal(pk.status, 302);
  assert.equal(await feat(b.slot.id), "auto", "the card keeps the stage - the owner asked for no jump while Plex moves on");
  assert.equal(await feat(bk.slot.id), null);
  for (let i = 0; i < 6; i++) { adv(10000); await beat(pk); }    // 80 s, the other stream live all along
  adv(9000); await beat(pk);                                    // 89 s
  await S.autoFeature(ROOM);
  assert.equal(await feat(b.slot.id), "auto", "89 s: still held");
  adv(2000); await beat(pk);                                    // 91 s
  await S.autoFeature(ROOM);
  assert.equal(await feat(b.slot.id), null);
  assert.equal(await feat(bk.slot.id), "auto");
  assert.deepEqual(await events(bk.slot.id, "featured"), ["auto: took over from the stream before it"]);
});

test("the marker only takes clean values: digits-only keys, plain text, a 📼 slot that is open", async () => {
  const b = await L.play(admin, { room: ROOM, key: "501" });
  assert.equal(await S.libraryUpNext(b.slot.id, { key: "../../library/metadata/1?X-Plex-Token=x", kind: "episode", title: "A\u0000\u0007b  c", show: "S".repeat(300), season: "x", episode: 3.5, year: 99999, poster: true }), true);
  const nx = (await featured()).next;
  assert.equal(nx.key, undefined, "a key that isn't a Plex rating key is dropped - and with it the poster");
  assert.equal(nx.poster, false);
  assert.equal(nx.title, "A b c");
  assert.equal(nx.show.length, 120);
  assert.equal(nx.season, null);
  assert.equal(nx.episode, null);
  assert.equal(nx.year, null);
  assert.equal(await S.libraryUpNext(b.slot.id, {}), false, "nothing to say");
  const u = await mkUser();
  const bk = await S.book(u, { minutes: 30, room: ROOM });
  assert.equal(await S.libraryUpNext(bk.slot.id, { key: "1", title: "x" }), false, "not a 📼 slot");
  await L.stop(admin, ROOM);
  assert.equal(await S.libraryUpNext(b.slot.id, { key: "1", title: "x" }), false, "ended");
  assert.equal((await S.getSlot(b.slot.id)).upnext, null, "ending clears it");
});

// ── upnext review fixes (each failed on the review build 945c8bfb) ──
test("review privacy F1: signed out, a starting title's card has no poster and no Plex rating key - featuredOf, roomStage and the homepage's front pad", async () => {
  const b = await L.play(admin, { room: ROOM, key: "501" });
  const out = await featured(null);
  assert.equal(out.id, b.slot.id);
  assert.equal(out.next.title, "Night of the Living Dead", "the title is public (the 📼 slot's own title says it)");
  assert.equal(out.next.poster, false);
  assert.equal("key" in out.next, false, "no rating key for a signed-out viewer / a scraper");
  const rs = await S.roomStage(ROOM, null);
  assert.equal(rs.featured.next.poster, false);
  assert.equal("key" in rs.featured.next, false);
  S.clearCache();
  const front = await S.featuredOf(ROOM, null, { front: true });
  assert.equal("key" in front.next, false);
  assert.equal((await featured(VIEWER)).next.key, "501", "signed in: the poster through /api/medialib/poster");
  assert.equal(S.upNextPoster(ROOM), true, "(/api/stage reads the sign-in only while this says so)");
  assert.equal(await S.featuredOf(ROOM, { userId: "" }).then((f) => "key" in f.next), false, "no user id: signed out");
});

test("review privacy F1: /api/stage reads the sign-in only while a starting title has a poster - the key for a signed-in viewer, none signed out", async () => {
  const express = require(path.join(repo, "node_modules", "express"));
  const B = require(path.join(repo, "bridge"));
  // no Approved pad anywhere: the handler reads the sign-in only for a reason of its own (as test/dock3-review-server.test.js)
  const PA = require(path.join(repo, "padaccess"));
  PA._reset(); await PA.init();
  for (const sd of rooms.SEEDS) await runQuery("INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES (?, 'members', ?, 'test') ON CONFLICT(room_id) DO UPDATE SET level = 'members'", [sd.room_id, T]);
  await runQuery("UPDATE pad_access SET level = 'members' WHERE level = 'approved'");
  PA._reset(); await PA.init();
  assert.equal(PA.anyApproved(), false);
  const app = express();
  app.use(express.json());
  let reads = 0;
  const addUser = (req, res, next) => { reads++; const h = req.headers["x-u"]; req.user = h ? { userId: h, username: h, class: "pleb" } : null; next(); };
  B.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  const srv = await new Promise((ok) => { const x = app.listen(0, "127.0.0.1", () => ok(x)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const slug = require(path.join(repo, "roomsweb")).linkSlug(await rooms.get(ROOM));
  const get = async (u) => (await fetch(base + "/api/stage?room=" + encodeURIComponent(slug), { headers: u ? { "x-u": u } : {} })).json();
  try {
    reads = 0;
    await get("v1");
    const base0 = reads;                                             // (whatever the handler reads for reasons of its own - an Approved pad, a cam)
    const b = await L.play(admin, { room: ROOM, key: "501" });
    S.clearCache();
    reads = 0;
    let d = await get("v1");
    assert.equal(reads, base0 + 1, "a starting title with a poster: the sign-in is read (once)");
    assert.equal(d.featured.id, b.slot.id);
    assert.equal(d.featured.next.key, "501", "signed in: the poster's key");
    assert.equal(d.featured.next.poster, true);
    d = await get();
    assert.equal(d.featured.next.title, "Night of the Living Dead");
    assert.equal(d.featured.next.poster, false, "signed out: no poster");
    assert.equal("key" in d.featured.next, false, "...and no rating key");
    await L.stop(admin, ROOM);
    const c = await L.play(admin, { room: ROOM, key: "502" });             // no poster in Plex
    S.clearCache();
    reads = 0;
    d = await get("v1");
    assert.equal(d.featured.id, c.slot.id);
    assert.equal(reads, base0, "no poster to hand out: no extra sign-in read");
    assert.equal(d.featured.next.title, "Carnival of Souls");
  } finally { srv.close(); }
});

test("review F4: a marker set while the title before kept publishing (its encoder didn't stop) is void once that stream beats on - no 'Coming up next' over a later pause, no let-go at its first drop", async () => {
  const b = await L.play(admin, { room: ROOM, key: "500" });
  const p = await pub(keyOf(last()));
  assert.equal(await feat(b.slot.id), "auto");
  // the queue / a control asked for the next title, but the old ffmpeg is still on the ingest
  assert.equal(await S.libraryUpNext(b.slot.id, { key: "501", kind: "movie", title: "Night of the Living Dead", year: 1968, poster: true }), true);
  for (let i = 0; i < 2; i++) { adv(10000); await beat(p); }       // it keeps beating: 20 s after the marker
  await done(p);                                                    // ...and pauses / drops
  assert.equal((await featured()).next, undefined, "a stale marker never reads as up next");
  adv(80000);                                                       // 100 s after the marker: the ordinary hold, nothing else live
  await S.autoFeature(ROOM);
  assert.equal(await feat(b.slot.id), "auto", "held as any dropped auto-feature - never 'up next didn't start'");
  assert.deepEqual(await events(b.slot.id, "unfeatured"), []);
  // control: the old title DID stop right after the marker (no beat after it) - up next as before
  const p2 = await pub(keyOf(last()));
  assert.equal(p2.status, 302);
  adv(5000); await beat(p2);
  assert.equal(await S.libraryUpNext(b.slot.id, { key: "502", kind: "movie", title: "Carnival of Souls", year: 1962 }), true);
  adv(1000); await done(p2);
  assert.equal((await featured()).next.title, "Carnival of Souls");
});

test("review privacy N1: one poster fetch per title for a pad full of viewers - the picture is kept a while by rating key (access still checked per request)", async () => {
  L._q._posters.clear();
  posterCalls = 0;
  const viewers = [admin, await mkUser(), await mkUser(), await mkUser()];
  const got = await Promise.all(viewers.map((u) => L.poster(u, "501")));
  for (const r of got) { assert.equal(r.status, 200); assert.deepEqual([...r.body], [1]); }
  assert.equal(posterCalls, 1, "4 viewers at once: one fetch");
  await L.poster(admin, "501");
  assert.equal(posterCalls, 1, "a moment later: still the kept one");
  await assert.rejects(L.poster(null, "501"), (e) => e.status === 401 || e.status === 403, "signed out: refused before the cache");
  await assert.rejects(L.poster(admin, "../1"), (e) => e.status === 400);
  await L.poster(admin, "500");
  assert.equal(posterCalls, 2, "another title: its own fetch");
});
