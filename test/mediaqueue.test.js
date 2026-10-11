// Offline tests for 1.99lr 📼 QUEUES (mediaqueue.js + medialib.js + mainstage library slots), end to end against the REAL
// media-control service (deploy/mediactl) running locally with a mocked Plex (a show with specials + 2 seasons) and a
// fake ffmpeg: building queues from the Plex hierarchy, one slot for the whole queue, titles + tracks per episode,
// billing per started hour (charged as it plays), out of PAT ends after the current title, next / previous / edit,
// a failing title is skipped, restart recovery (mediactl lost the stream; the site forgot the key), the daily cap
// (a queue = one play) and the "now playing" announcement's rate limit.
//   node --test test/mediaqueue.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mediaqueue-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SECRET = "q".repeat(48);
process.env.MEDIACTL_SECRET = SECRET;
delete process.env.MEDIACTL_TLS_SHA256;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const conf = require(path.join(repo, "mediaconf"));
const L = require(path.join(repo, "medialib"));
const Q = require(path.join(repo, "mediaqueue"));
const golive = require(path.join(repo, "golive"));
const M = require(path.join(repo, "deploy", "mediactl", "mediactl.js"));

// ── a Plex with one show: a special, season 1 (3 episodes, 40 min), season 2 (2 episodes); tracks in different orders ──
const media = path.join(tmp, "media");
fs.mkdirSync(media, { recursive: true });
const FILE = path.join(media, "show.mkv");
fs.writeFileSync(FILE, "x");
const DUR = 2400;
const EPS = [["901", 0, 1, "Behind the Scenes"], ["911", 1, 1, "Pilot"], ["912", 1, 2, "Second"], ["913", 1, 3, "Third"], ["921", 2, 1, "Return"], ["922", 2, 2, "Finale"]];
const brief = ([key, season, episode, title]) => ({ key, type: "episode", title, show: "The Show", season, episode, duration: DUR, show_key: "900", season_key: "90" + season });
const flip = (key) => Number(key) % 2 === 0;           // even keys list Japanese first
const plex = {
  async search() { return []; },
  async item(key) {
    if (key === "900") return { key, type: "show", title: "The Show", episodes: EPS.slice().reverse().map(brief) };    // out of order on purpose
    const e = EPS.find((x) => x[0] === key);
    if (e) {
      const eng = { index: flip(key) ? 2 : 1, label: "English", lang: "eng", default: !flip(key) }, jpn = { index: flip(key) ? 1 : 2, label: "Japanese", lang: "jpn", default: flip(key) };
      const sEng = { index: flip(key) ? 4 : 3, rel: 0, label: "English", lang: "eng", codec: "srt", burnable: true, image: false, forced: false };
      const sJpn = { index: flip(key) ? 3 : 4, rel: 1, label: "Japanese", lang: "jpn", codec: "srt", burnable: true, image: false, forced: false };
      return { ...brief(e), file: FILE, width: 1920, height: 1080, hdr: false, audio: flip(key) ? [jpn, eng] : [eng, jpn], subs: flip(key) ? [sJpn, sEng] : [sEng, sJpn] };
    }
    if (key === "777") return { key, type: "episode", title: "Broken", show: "Other", season: 1, episode: 1, duration: 600, file: null };
    if (key === "500") return { key, type: "movie", title: "Charade", year: 1963, file: FILE, duration: 6780, audio: [], subs: [] };
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
const mcfg = M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_MEDIA_ROOTS: media + path.sep, PLEX_TOKEN: "t" });
const mstreams = M.makeStreams(mcfg, plex, fakeSpawn, undefined, async () => null);
const { server } = M.makeServer(mcfg, { plex, streams: mstreams });

let n = 0;
async function mkUser(cls = "pleb", balance = 0) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?)", [id, "user" + n, "User " + n, cls, balance]);
  return { userId: id, username: "user" + n, class: cls };
}
const ROOM = "PepeFrog.Room";
const tick = () => new Promise((r) => setImmediate(r));
const last = () => procs[procs.length - 1];
const keyOf = (p) => { const url = p.args[p.args.length - 1]; return url.slice(S.RTMP_PUBLIC.length + 1); };
const pub = (key) => S.rtmpCallback({ call: "publish", app: "stage", name: key, addr: "1.2.3.4", clientid: String(Math.random()) });
const argv = (p) => p.args.join(" ");
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const queueRow = async (id) => (await getQuery("SELECT * FROM media_queues WHERE id = ?", [id]))[0];
const sessionRow = async () => (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [ROOM]))[0];
const slotOf = async (id) => S.getSlot(id);
/** the title on now plays `sec` seconds (ffmpeg progress), then finishes */
async function playFor(sec) { last().stdout.write(`out_time_us=${Math.round(sec * 1e6)}\n`); await tick(); }
async function finish() { const p = last(); p.stdout.write(`out_time_us=${DUR * 1e6}\n`); await tick(); p.emit("exit", 0); await tick(); }
let admin, member, payer;
const announced = [];
let realNowPlaying = null;

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.MEDIACTL_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ max_concurrent: 4, idle_grace_min: 5, enabled: true }, "test");
  await L.init();
  require(path.join(repo, "shop"));
  for (let i = 0; i < 100 && !(await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'shop_order_events'")).length; i++) await new Promise((r) => setTimeout(r, 20));
  admin = await mkUser("Admin"); member = await mkUser(); payer = await mkUser("pleb", 1000000);
  await conf.set({ library_enabled: true, library_plex: true, library_price: 100000, library_daily_cap: 3, library_free_daily_cap: 5,
                   library_users: member.username, library_queue_announce_min: 20 }, "test");
  realNowPlaying = golive.nowPlaying;
  golive.nowPlaying = async (o) => { announced.push(o); return { announced: true }; };      // counted, not sent
});
test.after(() => { mstreams.stopAll(); server.close(); });

// ── pure ──
test("building from the Plex hierarchy: rest of the season, the season, the series from here (specials only from a special), the series", () => {
  const eps = EPS.slice().reverse().map(brief);
  const keys = (a) => a.map((x) => x.key);
  const e912 = brief(EPS[2]);
  assert.deepEqual(keys(Q.buildQueue(eps, e912, "episode")), ["912"]);
  assert.deepEqual(keys(Q.buildQueue(eps, e912, "season_rest")), ["912", "913"]);
  assert.deepEqual(keys(Q.buildQueue(eps, e912, "season")), ["911", "912", "913"]);
  assert.deepEqual(keys(Q.buildQueue(eps, e912, "series_from")), ["912", "913", "921", "922"]);
  assert.deepEqual(keys(Q.buildQueue(eps, brief(EPS[0]), "series_from")), ["901", "911", "912", "913", "921", "922"], "from a special: everything after it");
  assert.deepEqual(keys(Q.buildQueue(eps, null, "series")), ["911", "912", "913", "921", "922"], "a whole series leaves out the specials");
  assert.deepEqual(keys(Q.buildQueue(eps, { ...e912, key: "999" }, "season")), ["999"], "an episode that isn't in the list: just it");
  // limits: titles and hours (what's left of the first from the start point)
  const five = Q.buildQueue(eps, null, "series");
  let c = Q.capQueue(five, 0, { maxItems: 3, maxSec: 99999 });
  assert.deepEqual([c.items.length, c.total_sec, c.truncated], [3, 3 * DUR, true]);
  c = Q.capQueue(five, 1200, { maxItems: 60, maxSec: 2 * 3600 });
  assert.deepEqual([c.items.length, c.total_sec], [3, 1200 + 2 * DUR], "1.33 h + 40 min fits 2 h, a 4th doesn't");
  c = Q.capQueue(five, 0, { maxItems: 60, maxSec: 60 });
  assert.equal(c.items.length, 1, "the first title always stays");
  // money
  assert.equal(Q.estimate(100000, 3 * DUR), 200000, "2 h of episodes = 2 started hours");
  assert.equal(Q.estimate(100000, 1), 100000);
  assert.equal(Q.estimate(0, 9999), 0);
  assert.equal(Q.hoursNeeded(0, DUR, 0), 1);
  assert.equal(Q.hoursNeeded(DUR, DUR, 0), 2);
  assert.equal(Q.hoursNeeded(2 * DUR, DUR, 0), 2);
  assert.equal(Q.hoursNeeded(3 * DUR, DUR, 0), 3);
});

test("tracks follow the language, not the index", async () => {
  const a = await plex.item("911"), b = await plex.item("912");
  const P = Q.prefsFrom(a, { quality: 720, audio: 2, sub: 3 });                 // Japanese audio, English subs on 911
  assert.deepEqual([P.audio_lang, P.sub_lang, P.sub_on], ["jpn", "eng", true]);
  assert.deepEqual(Q.pickTracks(b, P), { audio: 1, sub: 4 }, "912 lists them the other way round");
  assert.deepEqual(Q.pickTracks(b, Q.prefsFrom(a, { quality: 720, audio: null, sub: null })), { audio: null, sub: null }, "defaults stay defaults");
  assert.deepEqual(Q.pickTracks({ audio: [{ index: 1, lang: "fre" }], subs: [] }, P), { audio: null, sub: null }, "no match = the default / none");
});

// ── end to end ──
test("a Plex member's season: one slot, free, titles + tracks per episode, the next starts when one ends; a queue is one play", async () => {
  procs.length = 0;
  const pv = await Q.preview(member, { key: "912", scope: "season_rest" });
  assert.deepEqual(pv.items.map((x) => x.key), ["912", "913"]);
  assert.equal(pv.estimate, 0);
  const r = await Q.start(member, { room: ROOM, key: "912", scope: "season_rest", audio: 1, sub: 4, quality: 480 });   // Japanese + English subs on 912
  assert.equal(r.items, 2);
  assert.equal(r.price, 0);
  const slot = await slotOf(r.slot.id);
  assert.equal(slot.title, "📼 The Show — S1E2 Second");
  assert.ok(slot.max_minutes >= 80, "long enough for the whole queue");
  assert.equal(procs.length, 1);
  assert.match(argv(last()), /-map 0:1/, "Japanese on 912");
  const key1 = keyOf(last());
  assert.equal((await pub(key1)).status, 302, "the queue's key publishes");
  await playFor(60);
  await L.watch();
  let s = await sessionRow();
  assert.equal(s.live, 1);
  assert.equal(s.queue_id, r.queue_id);
  // a second queue / play on the same pad is refused while it plays
  await assert.rejects(Q.start(admin, { room: ROOM, key: "911" }), (e) => e.status === 409);
  await assert.rejects(L.play(admin, { room: ROOM, key: "500" }), (e) => e.status === 409);
  // episode 1 ends: the watcher starts 913 on the SAME slot with the same key, Japanese = index 2 there, subs English = 3
  await finish();
  await L.watch();
  assert.equal(procs.length, 2);
  assert.equal(keyOf(last()), key1, "same slot, same key");
  assert.match(argv(last()), /-map 0:2/);
  assert.match(argv(last()), /subtitles=.*:si=0/, "English subs (rel 0 on 913)");
  assert.equal((await slotOf(r.slot.id)).title, "📼 The Show — S1E3 Third", "the title follows the episode");
  s = await sessionRow();
  assert.equal(s.slot_id, r.slot.id);
  assert.equal(s.title, "The Show — S1E3 Third");
  const plays = await getQuery("SELECT * FROM media_plays WHERE queue_id = ? ORDER BY id", [r.queue_id]);
  assert.deepEqual(plays.map((p) => [p.queue_pos, p.charge, p.end_reason || null]), [[0, "free", "finished"], [1, "free", null]]);
  assert.equal(await L.freeToday(member.userId), 1, "a queue is ONE play towards the daily cap");
  // the last one ends: the queue and the slot end
  await pub(key1);
  await finish();
  await L.watch();
  assert.equal((await queueRow(r.queue_id)).state, "ended");
  assert.equal((await queueRow(r.queue_id)).end_reason, "finished");
  assert.equal((await slotOf(r.slot.id)).status, "ended");
  assert.equal(await sessionRow(), undefined);
});

test("announcements: the first title is the go-live (not here); the next only after the gap; titles always update", async () => {
  announced.length = 0;
  let clock = Date.now();
  Q._setClock(() => clock);
  try {
    const r = await Q.start(admin, { room: ROOM, key: "900" });                        // a show: the whole series
    assert.equal(r.items, 5);
    await pub(keyOf(last()));
    await finish(); await L.watch();                                                 // 5 min later (the gap is 20)
    assert.equal(announced.length, 0, "too soon after the start");
    assert.equal((await slotOf(r.slot.id)).title, "📼 The Show — S1E2 Second", "the title moved on anyway");
    clock += 21 * 60000;
    await finish(); await L.watch();
    assert.equal(announced.length, 1);
    assert.deepEqual([announced[0].roomId, announced[0].what], [ROOM, "The Show — S1E3 Third"]);
    clock += 60000;
    await finish(); await L.watch();
    assert.equal(announced.length, 1, "one a gap");
    await conf.set({ library_queue_announce_min: 0 }, "test");
    await finish(); await L.watch();
    assert.equal(announced.length, 2, "0 = every title");
    await L.stop(admin, ROOM);
  } finally { Q._setClock(null); await conf.set({ library_queue_announce_min: 20 }, "test"); }
});

test("billing: estimate up front, charged per started hour as it plays (held, then routed), covered titles cost nothing", async () => {
  procs.length = 0;
  const b0 = await bal(payer);
  const pv = await Q.preview(payer, { key: "911", scope: "season" });
  assert.deepEqual([pv.items.length, pv.estimate, pv.first_charge, pv.per_hour], [3, 200000, 100000, 100000]);
  await assert.rejects(Q.start(payer, { room: ROOM, key: "911", scope: "season" }), (e) => e.status === 400 && e.extra.estimate === 200000, "confirm first");
  await assert.rejects(Q.start(payer, { room: ROOM, key: "911", scope: "season", estimate: 100000 }), (e) => e.status === 409);
  assert.equal(await bal(payer), b0, "nothing charged");
  const r = await Q.start(payer, { room: ROOM, key: "911", scope: "season", estimate: 200000 });
  assert.equal(r.price, 100000, "the first hour now");
  assert.equal(await bal(payer), b0 - 100000);
  let p = (await getQuery("SELECT * FROM media_plays WHERE queue_id = ? ORDER BY id", [r.queue_id]));
  assert.deepEqual([p[0].charge, p[0].hours, p[0].price], ["held", 1, 100000]);
  await pub(keyOf(last()));
  await playFor(30); await L.watch();
  assert.equal((await getQuery("SELECT charge FROM media_plays WHERE id = ?", [p[0].id]))[0].charge, "routed", "on the stage: routed");
  const led = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = ?", ["library:" + p[0].id]))[0];
  assert.deepEqual([led.kind, led.amount, led.fortknox, led.room_vault], ["library_play", 100000, 50000, 50000]);
  // ep 2: 40 + 40 min = 2 started hours -> one more hour
  await finish(); await L.watch();
  assert.equal(await bal(payer), b0 - 200000);
  // the mine() view: what's paid, what's left
  const v = (await L.mine(payer)).queues[0];
  assert.deepEqual([v.pos, v.count, v.paid_hours, v.est_left, v.next_charge], [1, 3, 2, 0, 0]);
  // ep 3: 120 min = still 2 hours -> covered, no charge
  await finish(); await L.watch();
  assert.equal(await bal(payer), b0 - 200000);
  p = (await getQuery("SELECT charge, hours, price FROM media_plays WHERE queue_id = ? ORDER BY id", [r.queue_id]));
  assert.deepEqual(p.map((x) => x.charge), ["routed", "routed", "covered"]);
  assert.equal(await L.paidToday(payer.userId), 1, "one paid play for the whole queue");
  await finish(); await L.watch();
  assert.equal((await queueRow(r.queue_id)).state, "ended");
  assert.equal(await bal(payer), b0 - 200000, "= the estimate");
});

test("out of PAT: the queue ends after the current title, with a notice; a skipped title only counts what played", async () => {
  procs.length = 0;
  const poor = await mkUser("pleb", 150000);
  const r = await Q.start(poor, { room: ROOM, key: "900", estimate: 400000 });            // 5 x 40 min = 4 h
  assert.equal(await bal(poor), 50000);
  await pub(keyOf(last()));
  // skip ep 1 after 10 minutes: only 10 min played, so ep 2 (40 min) still fits the first hour
  await playFor(600); await L.watch();
  await Q.next(poor, ROOM);
  assert.equal(await bal(poor), 50000, "50 min played in all: no new hour");
  assert.equal((await queueRow(r.queue_id)).played_sec, 600);
  let v = (await L.mine(poor)).queues[0];
  assert.equal(v.next_charge, 100000);
  assert.equal(v.low, true, "the page warns: the next title needs more than they have");
  // ep 2 ends: ep 3 needs a second hour, they have 50,000
  await finish(); await L.watch();
  const q = await queueRow(r.queue_id);
  assert.deepEqual([q.state, q.end_reason, q.notice], ["ended", "out of PAT", "out_of_pat"]);
  assert.equal((await slotOf(r.slot.id)).status, "ended");
  assert.equal(await bal(poor), 50000, "nothing more taken");
  v = (await L.mine(poor)).queues[0];
  assert.deepEqual([v.state, v.notice], ["ended", "out_of_pat"], "the Go-live page shows why");
});

test("next / previous / edit what's left; the last title can't be skipped; others can't touch it", async () => {
  procs.length = 0;
  const r = await Q.start(admin, { room: ROOM, key: "900" });
  const other = await mkUser();
  await assert.rejects(Q.next(other, ROOM), (e) => e.status === 403);
  await Q.next(admin, ROOM);
  assert.equal((await sessionRow()).rating_key, "912");
  await Q.prev(admin, ROOM);
  assert.equal((await sessionRow()).rating_key, "911");
  await assert.rejects(Q.prev(admin, ROOM), (e) => e.status === 409);
  await assert.rejects(Q.edit(admin, ROOM, { op: "remove", index: 0 }), (e) => e.status === 400, "not what's on / played");
  await Q.edit(admin, ROOM, { op: "remove", index: 1 });                                 // drop 912
  await Q.edit(admin, ROOM, { op: "move", index: 3, to: 1 });                            // 922 next
  await Q.edit(admin, ROOM, { op: "add", keys: ["500"] });                               // + a movie at the end
  const v = (await L.state(admin)).queues.find((x) => x.id === r.queue_id);
  assert.deepEqual(v.next.map((x) => x.key), ["922", "913", "921", "500"]);
  await Q.next(admin, ROOM);
  assert.equal((await sessionRow()).rating_key, "922");
  for (let i = 0; i < 3; i++) await Q.next(admin, ROOM);
  assert.equal((await sessionRow()).rating_key, "500");
  await assert.rejects(Q.next(admin, ROOM), (e) => e.status === 409 && /last title/.test(e.message));
  await L.stop(admin, ROOM);
  assert.equal((await queueRow(r.queue_id)).state, "ended");
  assert.equal(mstreams.list().length, 0);
});

test("a title that fails is logged and skipped; a paid title that never got going is refunded", async () => {
  procs.length = 0;
  const u = await mkUser("pleb", 1000000);
  const r = await Q.start(u, { room: ROOM, keys: ["911", "777", "912"], estimate: 200000 });
  assert.equal(r.items, 3);
  await pub(keyOf(last()));
  await finish(); await L.watch();
  // 777 has no file: logged, skipped straight to 912
  const skipped = (await getQuery("SELECT * FROM media_plays WHERE queue_id = ? AND queue_pos = 1", [r.queue_id]))[0];
  assert.match(skipped.end_reason, /skipped/);
  assert.equal((await sessionRow()).rating_key, "912");
  const held = (await getQuery("SELECT * FROM media_plays WHERE queue_id = ? AND queue_pos = 2", [r.queue_id]))[0];
  assert.equal(held.charge, "held", "912 needed the second hour");
  const before = await bal(u);
  // ffmpeg dies before a single frame, in every mode -> mediactl `error` -> refunded, and the queue (nothing left) ends
  for (let i = 0; i < 4; i++) { const p = last(); p.emit("exit", 1); await tick(); await tick(); }
  await L.watch();
  assert.equal((await getQuery("SELECT charge FROM media_plays WHERE id = ?", [held.id]))[0].charge, "refunded");
  assert.equal(await bal(u), before + 100000);
  const q = await queueRow(r.queue_id);
  assert.equal(q.state, "ended");
  assert.equal(q.paid_hours, 1, "the refunded hour is off the books");
});

test("restart recovery: media-control lost the stream -> the same title again where it was; the site forgot the key -> a fresh one", async () => {
  procs.length = 0;
  const r = await Q.start(admin, { room: ROOM, key: "912", scope: "season_rest" });
  const oldKey = keyOf(last());
  await pub(oldKey);
  await playFor(300); await L.watch();
  // both restart: mediactl forgets every stream, the site forgets the raw key
  mstreams._streams.clear();
  L._keys.clear();
  await L.watch();
  const s = await sessionRow();
  assert.equal(s.rating_key, "912", "the same title");
  assert.match(argv(last()), /-ss 300\.000/, "where it was");
  const newKey = keyOf(last());
  assert.notEqual(newKey, oldKey, "a fresh key for the same slot");
  assert.equal((await pub(newKey)).status, 302);
  assert.equal((await pub(oldKey)).status, 403, "the old key is dead");
  assert.equal(s.slot_id, r.slot.id);
  // a session-less queue (the site stopped between two titles) picks up on the next look
  await runQuery("DELETE FROM media_sessions WHERE room_id = ?", [ROOM]);
  mstreams._streams.clear();
  await runQuery("UPDATE media_queues SET pos = 1 WHERE id = ?", [r.queue_id]);
  await L.watch();
  assert.equal((await sessionRow()).rating_key, "913");
  await L.stop(admin, ROOM);
});

test("a queue that's still starting is left alone by the watcher; a start that never finished is closed after 2 min", async () => {
  const r = await Q.start(admin, { room: ROOM, key: "912", scope: "season_rest" });
  assert.equal((await queueRow(r.queue_id)).state, "active");
  // another process (a script on the same DB) mid-start: state 'starting' with its first title's session already in
  await runQuery("UPDATE media_queues SET state = 'starting', updated = ? WHERE id = ?", [Date.now(), r.queue_id]);
  mstreams._streams.clear();                                                    // even with the stream "lost"
  const before = procs.length;
  await L.watch();
  assert.equal(procs.length, before, "nothing restarted, nothing stopped");
  assert.equal((await queueRow(r.queue_id)).state, "starting");
  await assert.rejects(Q.start(admin, { room: ROOM, key: "911" }), (e) => e.status === 409, "the pad is taken while it starts");
  await runQuery("UPDATE media_queues SET updated = ? WHERE id = ?", [Date.now() - 3 * 60000, r.queue_id]);
  await L.watch();
  assert.equal((await queueRow(r.queue_id)).state, "ended");
  assert.equal((await slotOf(r.slot.id)).status, "ended");
});

test("the slot ending (Cut, a long pause) ends the queue; the settings switch queues off", async () => {
  const r = await Q.start(admin, { room: ROOM, key: "900" });
  await S.end(r.slot.id, "cut", "someone");
  await L.watch();
  assert.equal((await queueRow(r.queue_id)).state, "ended");
  assert.equal(mstreams.list().length, 0);
  await conf.set({ library_queue: false }, "test");
  await assert.rejects(Q.start(admin, { room: ROOM, key: "900" }), (e) => e.status === 403);
  await conf.set({ library_queue: true }, "test");
});

test("golive.nowPlaying: the pad's chat line (np) + Pepe's relay job 'nowplaying', and the pad owner's switch", async () => {
  const bridge = require(path.join(repo, "bridge"));
  const rooms = require(path.join(repo, "rooms"));
  const seen = [];
  const keep = { n: bridge.liveNotice, a: bridge.liveAnnounce, g: rooms.get };
  bridge.liveNotice = async (room, o) => { seen.push(["notice", room, o]); return true; };
  bridge.liveAnnounce = async (room, o) => { seen.push(["job", room, o]); return true; };
  rooms.get = async (id) => (id === ROOM ? { id: ROOM, slug: "pepe", title: "Pepe's pad" } : null);
  try {
    const r = await realNowPlaying({ roomId: ROOM, userId: admin.userId, display: "Admin", what: "The Show — S1E2 Second" });
    assert.equal(r.announced, true);
    assert.equal(seen[0][2].np, true);
    assert.equal(seen[0][2].what, "The Show — S1E2 Second");
    assert.equal(seen[1][2].np, true);
    assert.match(seen[1][2].link, /^https:\/\/publicaccess\.tv\//);
    await runQuery("INSERT INTO golive_pad (room_id, announce, updated) VALUES (?, 0, 0) ON CONFLICT(room_id) DO UPDATE SET announce = 0", [ROOM]);
    seen.length = 0;
    assert.equal((await realNowPlaying({ roomId: ROOM, what: "x" })).announced, false, "the owner switched pad announcements off");
    assert.equal(seen.length, 0);
  } finally { bridge.liveNotice = keep.n; bridge.liveAnnounce = keep.a; rooms.get = keep.g; }
});

// ── 1.99lw: the pad page's player (DJ controls), booking a 📼 slot for later, the pad's 📼 limit ──
test("the player: everyone sees title + progress read-only; the starter, the pad's owner and admins control it; the log says who did what", async () => {
  procs.length = 0;
  const starter = await mkUser("pleb", 0);
  await conf.set({ library_users: member.username + "," + starter.username }, "test");
  await Q.start(starter, { room: ROOM, key: "911", scope: "season" });
  await pub(keyOf(last()));
  await playFor(120); await L.watch();
  const anon = await L.player(null, ROOM);
  assert.deepEqual([anon.on, anon.title, anon.can_control, anon.log.length], [true, "The Show — S1E1 Pilot", false, 0]);
  assert.equal(anon.queue.count, 3);
  assert.ok(anon.position >= 120 && anon.duration === DUR);
  const viewer = await mkUser();
  assert.equal((await L.player(viewer, ROOM)).can_control, false);
  await assert.rejects(L.pause(viewer, ROOM), (e) => e.status === 403);
  await assert.rejects(Q.next(viewer, ROOM), (e) => e.status === 403);
  // the pad's owner (rooms.canManage) may
  const rooms = require(path.join(repo, "rooms"));
  const keep = rooms.canManage;
  const padOwner = await mkUser();
  rooms.canManage = async (u, roomId) => !!u && u.userId === padOwner.userId && roomId === ROOM;
  try {
    assert.equal((await L.player(padOwner, ROOM)).can_control, true);
    await L.pause(padOwner, ROOM);
    await L.seek(starter, ROOM, 300);
    await Q.next(padOwner, ROOM);
  } finally { rooms.canManage = keep; }
  const v = await L.player(starter, ROOM);
  assert.equal(v.can_control, true);
  assert.deepEqual(v.log.slice(0, 3).map((l) => [l.username, l.action]), [[padOwner.username, "next"], [starter.username, "seek"], [padOwner.username, "pause"]]);
  assert.match(v.log[1].detail, /→ 5:00/);
  await L.stop(starter, ROOM);
  assert.equal((await L.player(null, ROOM)).on, false);
  await conf.set({ library_users: member.username }, "test");
});

test("booking a 📼 slot for later: sized to the runtime + 5 min, starts by itself at its time with the play's rules; can't pay = it doesn't start + a notice", async () => {
  procs.length = 0;
  const u = await mkUser("pleb", 1000000);
  const at = Date.now() + 10 * 60000;
  const pv = await Q.preview(u, { key: "912", scope: "season_rest", room: ROOM, when: "later" });
  assert.equal(pv.slot_minutes, Math.ceil(2 * DUR / 60) + 5);
  await assert.rejects(Q.book(u, { room: ROOM, key: "912", scope: "season_rest", start_at: at }), (e) => e.status === 400 && e.extra.estimate === 200000);
  const r = await Q.book(u, { room: ROOM, key: "912", scope: "season_rest", start_at: at, estimate: 200000, audio: 1 });
  assert.equal(r.minutes, 85);
  let slot = await slotOf(r.slot.id);
  assert.deepEqual([slot.status, slot.source, slot.max_minutes, slot.held], ["scheduled", "library", 85, 0]);
  assert.equal(await bal(u), 1000000, "nothing taken when booking");
  await L.watch();
  assert.equal(procs.length, 0, "not before its time");
  Q._setClock(() => Date.now() + 11 * 60000);
  try { await L.watch(); } finally { Q._setClock(null); }
  slot = await slotOf(r.slot.id);
  assert.equal(slot.status, "waiting", "opened with a key");
  assert.equal(procs.length, 1);
  assert.match(argv(last()), /-map 0:1/, "the booked audio choice");
  assert.equal((await pub(keyOf(last()))).status, 302);
  assert.equal(await bal(u), 900000, "the first hour, as it plays");
  const bk = (await getQuery("SELECT * FROM media_bookings WHERE slot_id = ?", [r.slot.id]))[0];
  assert.equal(bk.state, "started");
  assert.equal((await queueRow(bk.queue_id)).slot_id, r.slot.id, "the queue plays in the booked slot");
  await L.stop(u, ROOM);
  // a booking whose owner can't pay when it starts
  const broke = await mkUser("pleb", 0);
  const r2 = await Q.book(broke, { room: ROOM, key: "911", start_at: at, estimate: 100000 });
  assert.equal(r2.minutes, 45);
  Q._setClock(() => Date.now() + 11 * 60000);
  try { await L.watch(); } finally { Q._setClock(null); }
  const bk2 = (await getQuery("SELECT * FROM media_bookings WHERE slot_id = ?", [r2.slot.id]))[0];
  assert.equal(bk2.state, "failed");
  assert.match(bk2.error, /out of PAT/);
  assert.equal((await slotOf(r2.slot.id)).status, "ended");
  assert.equal(mstreams.list().filter((x) => x.state === "playing").length, 0);
  // cancelled before its time (the user ended the booking)
  const r3 = await Q.book(member, { room: ROOM, key: "911", start_at: at });
  await S.end(r3.slot.id, "cancelled", member.username);
  Q._setClock(() => Date.now() + 11 * 60000);
  try { await L.watch(); } finally { Q._setClock(null); }
  assert.equal((await getQuery("SELECT state FROM media_bookings WHERE slot_id = ?", [r3.slot.id]))[0].state, "cancelled");
});

test("the pad's 📼 limit: a pad whose owner set a longest slot caps queues (cut to fit) and refuses a longer single play", async () => {
  const keep = S.limitsFor;
  S.limitsFor = async () => ({ max: 60, library_max: 60, min: 5 });
  try {
    const pv = await Q.preview(admin, { key: "900", room: ROOM });
    assert.equal(pv.items.length, 1, "40-min episodes: one fits in 60 min with the slack");
    assert.equal(pv.truncated, true);
    await assert.rejects(L.play(admin, { room: ROOM, key: "500" }), (e) => e.status === 400 && /at most 60 minutes/.test(e.message));
  } finally { S.limitsFor = keep; }
});
