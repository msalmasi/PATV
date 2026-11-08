// 1.99?? site: plexqueue (owner 2026-11-08: "when i use !plex to add stuff to the stage, or use the video clerk mode, i seem to get the option
// to replace whats on the stage, but i should get the option of adding to the queue as well"): Pepe's bot route (plexchat.js POST
// /api/medialib/bot) gets /stage's "+ Add to the queue" - op play mode "queue" = mediaqueue.queueFor - against the REAL media-control service
// (deploy/mediactl, a mocked Plex + a fake ffmpeg), the test/upnext3.test.js harness:
//   * a running queue the speaker may grow (theirs; a FREE one for a library admin): the titles go on its END (/stage's edit op add - mode next
//     still puts them right after the title on now), what it adds confirmed like a queue's start (400 / 409 estimate)
//   * anything else from Plex on (a single title, someone else's running queue): a queue of the speaker's OWN lined up after it
//     (mediaqueue.after - the line's rules: AFTER_MAX people, a second ask grows your own row, billed to you as it plays, the points for its
//     first title at the press)
//   * the answer says where it landed (how, place, line, eta_sec); padState tells Pepe what "queue" would do (queue_as / queue_why /
//     can_after / line / booking_due) and the search rows carry what it costs (queue_cost)
//   * nothing on: nothing_on (Pepe asks a plain play); a live stream holding every slot of the pad: slot_taken; a queue starting: busy_queue
//   * a due booking: no replace offered (can_replace false), lining up still works; an 18+ pad: pad; out of points: pat with need + have;
//     the audit row of a chat line-up (pepe_after) is hidden from a plain starter's 📼 log, like the website's own queue_after rows
//   TZ=UTC node --test test/plexchat-queue.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexchat-queue-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SECRET = "q".repeat(48);
const PLEX_TOKEN = "plex-token-never-in-a-page-4c3b2a";
process.env.MEDIACTL_SECRET = SECRET;
delete process.env.MEDIACTL_TLS_SHA256;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));
const conf = require(path.join(repo, "mediaconf"));
const L = require(path.join(repo, "medialib"));
const Q = require(path.join(repo, "mediaqueue"));
const PA = require(path.join(repo, "padaccess"));
const golive = require(path.join(repo, "golive"));
const PC = require(path.join(repo, "plexchat"));
const M = require(path.join(repo, "deploy", "mediactl", "mediactl.js"));

const media = path.join(tmp, "media");
fs.mkdirSync(media, { recursive: true });
const FILE = path.join(media, "secret-library-path.mkv");
fs.writeFileSync(FILE, "x");
const DUR = 2400;
const EPS = [["911", 1, 1, "Pilot"], ["912", 1, 2, "Second"], ["913", 1, 3, "Third"]];
const brief = ([key, season, episode, title]) => ({ key, type: "episode", title, show: "The Show", season, episode, duration: DUR, show_key: "900", season_key: "901", poster: true });
const MOV = { 500: ["Charade", 1963, 6780], 501: ["Night of the Living Dead", 1968, 5760], 502: ["Carnival of Souls", 1962, 4680] };
const movBrief = (k) => ({ key: String(k), type: "movie", title: MOV[k][0], year: MOV[k][1], duration: MOV[k][2], poster: true });
const plex = {
  async search(q) {
    const w = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    return Object.keys(MOV).filter((k) => w.every((x) => MOV[k][0].toLowerCase().includes(x))).map(movBrief);
  },
  async item(key) {
    if (key === "900") return { key, type: "show", title: "The Show", episodes: EPS.map(brief) };
    const e = EPS.find((x) => x[0] === key);
    if (e) return { ...brief(e), file: FILE, width: 1920, height: 1080, hdr: false, audio: [], subs: [] };
    if (MOV[key]) return { ...movBrief(key), file: FILE, audio: [], subs: [] };
    const err = new Error("Not in the Plex library"); err.status = 404; throw err;
  },
  async poster() { return { type: "image/jpeg", body: Buffer.from([1]) }; },
};
const procs = [];
function fakeSpawn(cmd, args) {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.args = args;
  p.kill = () => { if (p.dead) return; p.dead = true; setImmediate(() => p.emit("exit", null, "SIGTERM")); };
  p.finish = () => { p.dead = true; p.stdout.write(`out_time_us=${DUR * 1e6}\n`); setImmediate(() => p.emit("exit", 0, null)); };
  procs.push(p);
  return p;
}
const mcfg = M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_MEDIA_ROOTS: media + path.sep, PLEX_TOKEN, MEDIACTL_MAX_STREAMS: "4" });
const mstreams = M.makeStreams(mcfg, plex, fakeSpawn, undefined, async () => null);
const { server } = M.makeServer(mcfg, { plex, streams: mstreams });

let T = Date.now();
S._setClock(() => T);
Q._setClock(() => T);
let n = 0;
async function mkUser(cls = "pleb", balance = 0) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                 [id, "user" + n, "User " + n, cls, balance, "cf_user" + n]);
  return { userId: id, username: "user" + n, class: cls };
}
const ROOM = "Queue.Room";          // owned by `owner`, 4 slots
const OTHER = "Queue.Other";
const ONE = "Queue.One";            // ONE stage slot
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const last = () => procs[procs.length - 1];
const keyOf = (p) => { const url = p.args[p.args.length - 1]; return url.slice(S.RTMP_PUBLIC.length + 1); };
let cids = 0;
async function pub(key) { const cid = String(++cids); const r = await S.rtmpCallback({ call: "publish", app: "stage", name: key, addr: "1.2.3.4", clientid: cid }); return { status: r.status, cid, key }; }
const goLive = () => pub(keyOf(last()));
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const rowsOf = async (room = ROOM) => getQuery("SELECT * FROM media_queues WHERE room_id = ? AND state = 'after' ORDER BY id", [room]);
const activeQ = async (room = ROOM) => (await getQuery("SELECT * FROM media_queues WHERE room_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1", [room]))[0] || null;
const asU = (u) => ({ user_id: u.userId });
const call = (b) => PC.handle({ via: "room", ...b });
const search = (u, q, room = ROOM) => call({ op: "search", as: asU(u), room, q });
const queueIt = (u, key, extra = {}, room = ROOM) => call({ op: "play", as: asU(u), room, key, scope: "title", mode: "queue", ...extra });
const near = (v, lo, hi) => typeof v === "number" && v >= lo && v <= hi;
let admin, owner;
async function clear() {
  for (const q of await getQuery("SELECT id FROM media_queues WHERE state IN ('active','starting','after')")) await runQuery("UPDATE media_queues SET state = 'ended' WHERE id = ?", [q.id]);
  await runQuery("DELETE FROM media_sessions");
  mstreams.stopAll();
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  L._keys.clear();
  await S.setConfig({ takeover_mode: "when_idle", pepe_feature: null, pepe_feature_pads: {} }, "test");
  await conf.set({ library_price: 0, library_queue: true, library_break: false, library_enabled: true, library_daily_cap: 50, library_free_daily_cap: 50 }, "test");
  await runQuery("UPDATE media_plays SET ts = 0");
  PC._hits.clear();
  procs.length = 0;
  await settle();
}

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.MEDIACTL_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, email TEXT, discordId TEXT, twitchId TEXT, auto_source TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 8, bookings_per_hour: 100, idle_grace_min: 5, enabled: true }, "test");
  await L.init();
  require(path.join(repo, "shop"));
  for (let i = 0; i < 100 && !(await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'shop_order_events'")).length; i++) await new Promise((r) => setTimeout(r, 20));
  admin = await mkUser("Admin");
  owner = await mkUser();
  for (const [r, t] of [[ROOM, "Queue Pad"], [OTHER, "Other Pad"], [ONE, "One Slot Pad"]]) await rooms.addRoom(r, t, "test");
  await runQuery("UPDATE rooms_registry SET owner_kind = 'user', owner_user_id = ? WHERE room_id = ?", [owner.userId, ROOM]);
  await rooms.loadCache();
  for (const r of [ROOM, OTHER]) await rooms.setStage(r, { slot_count: 4, slot_price: 0, upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await rooms.setStage(ONE, { slot_count: 1, slot_price: 0, upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await PA.init();
  await conf.set({ library_enabled: true, library_break: false, library_plex: true, library_price: 0, library_daily_cap: 50, library_free_daily_cap: 50,
                   library_queue_announce_min: 20 }, "test");
  golive.nowPlaying = async () => ({ announced: true });
});
test.afterEach(clear);
test.after(() => { mstreams.stopAll(); server.close(); });

test("a single title on: a payer's \"queue it\" lines up a queue of their OWN after it - estimate confirmed (400 / 409), where it landed (place / line / about when), billed to them as it plays; padState says queue_as after and the rows carry queue_cost; a second ask grows their own row", async () => {
  await conf.set({ library_price: 50000 }, "test");
  const a = await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const bob = await mkUser("pleb", 2000000);
  const st = await search(bob, "night");
  assert.equal(st.ok, true, JSON.stringify(st));
  const lib = st.state.library;
  assert.deepEqual([lib.title, lib.queue, lib.can_replace, lib.can_after, lib.queue_as, lib.queue_why], ["Charade (1963)", false, false, true, "after", null]);
  assert.deepEqual(lib.line, { count: 0, place: null, mine: 0, full: false, max: Q.AFTER_MAX, held: false });
  assert.equal(lib.booking_due, null);
  assert.ok(near(lib.eta_sec, 6700, 6780), "about when a queue lined up now starts: " + lib.eta_sec);
  assert.deepEqual([st.rows[0].key, st.rows[0].price, st.rows[0].queue_cost], ["501", 100000, 100000], "what lining it up costs (2 started hours)");
  let r = await queueIt(bob, "501");
  assert.deepEqual([r.ok, r.code, r.estimate], [false, "estimate", 100000], "no confirmed figure -> estimate (400)");
  r = await queueIt(bob, "501", { estimate: 99999 });
  assert.deepEqual([r.ok, r.code, r.estimate], [false, "estimate", 100000], "a different one -> estimate (409) with the right figure");
  const b0 = await bal(bob);
  r = await queueIt(bob, "501", { estimate: 100000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.queued, r.how, r.place, r.line, r.behind, r.behind_queue, r.cost, r.per_hour, r.title, r.target],
                   [true, "after", 1, 1, "Charade (1963)", false, 100000, 50000, "Night of the Living Dead (1968)", "stage"]);
  assert.ok(near(r.eta_sec, 6700, 6780), "it starts when Charade ends: " + r.eta_sec);
  assert.equal(await bal(bob), b0, "nothing is taken at the press");
  const rows = await rowsOf();
  assert.deepEqual(rows.map((x) => [x.user_id, x.state, x.behind, x.per_hour]), [[bob.userId, "after", a.slot.id, 50000]], "the speaker's own row, behind what's on");
  const ctl = await getQuery("SELECT action, detail, user_id FROM media_controls WHERE room_id = ? ORDER BY id DESC LIMIT 2", [ROOM]);
  assert.deepEqual(ctl.map((x) => x.action), ["pepe_after", "queue_after"], "the line's own row + the chat audit row (its own action)");
  assert.match(ctl[0].detail, /^room chat: line up play 501 -> Night of the Living Dead \(1968\)/);
  // a second ask grows their own row - it costs what it ADDS
  const st2 = await search(bob, "carnival");
  assert.deepEqual([st2.state.library.queue_as, st2.state.library.line.place, st2.state.library.line.mine, st2.rows[0].queue_cost],
                   ["after", 1, 1, 50000], "their own waiting row: what it adds (3 started hours in all, 2 confirmed)");
  r = await queueIt(bob, "502", { estimate: 50000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.how, r.place, r.line, r.items, r.cost], ["after", 1, 1, 2, 50000]);
  assert.deepEqual(JSON.parse((await rowsOf())[0].items).map((x) => x.key), ["501", "502"]);
});

test("a running queue the speaker may grow: \"queue it\" goes on its END (mode next still right after what's on); place / about when; a paid queue confirms what it adds; padState says queue_as append", async () => {
  const c0 = (await getQuery("SELECT COALESCE(MAX(id), 0) AS m FROM media_controls"))[0].m;
  const starter = await mkUser();
  await Q.startFor(starter, { room: ROOM, keys: ["911", "912"] });
  await goLive();
  const st = await search(starter, "charade");
  assert.deepEqual([st.state.library.queue, st.state.library.can_add, st.state.library.queue_as, st.rows[0].queue_cost], [true, true, "append", 0]);
  let r = await queueIt(starter, "500");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.queued, r.how, r.place, r.items, r.cost, r.title], [true, "append", 2, 3, 0, "Charade (1963)"]);
  assert.ok(near(r.eta_sec, 2 * DUR - 80, 2 * DUR), "after the title on now and Second: " + r.eta_sec);
  r = await call({ op: "play", as: asU(starter), room: ROOM, key: "501", scope: "title", mode: "next" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(JSON.parse((await activeQ()).items).map((x) => x.key), ["911", "501", "912", "500"], "queue = the end, next = right after what's on");
  const ctl = await getQuery("SELECT action FROM media_controls WHERE room_id = ? AND id > ? AND action LIKE 'queue_%' ORDER BY id", [ROOM, c0]);
  assert.deepEqual(ctl.map((x) => x.action), ["queue_add", "queue_next"], "the end is logged as /stage's add");
  // a library admin on a FREE queue: appends too (mayGrow); the pad's owner (a controller) lines up their own instead
  const sa = await search(admin, "carnival");
  assert.equal(sa.state.library.queue_as, "append");
  const so = await search(owner, "carnival");
  assert.deepEqual([so.state.library.can_add, so.state.library.can_replace, so.state.library.queue_as], [false, true, "after"]);
  // paid: what it adds to the starter's bill is confirmed
  await conf.set({ library_price: 50000 }, "test");
  const bob = await mkUser("pleb", 2000000);
  await Q.startFor(bob, { room: OTHER, keys: ["911"], estimate: 50000 });
  await goLive();
  const sb = await search(bob, "charade", OTHER);
  const cost = sb.rows[0].queue_cost;
  assert.ok(sb.state.library.queue_as === "append" && cost > 0, "what it adds: " + cost);
  r = await queueIt(bob, "500", {}, OTHER);
  assert.deepEqual([r.ok, r.code, r.estimate], [false, "estimate", cost]);
  r = await queueIt(bob, "500", { estimate: cost }, OTHER);
  assert.deepEqual([r.ok, r.how, r.cost, r.place], [true, "append", cost, 1]);
});

test("behind someone else's RUNNING queue: a queue of your own lined up after it (behind_queue / behind_left; it starts after the queue's titles); the pad's owner on a single title may both replace and line up", async () => {
  const starter = await mkUser();
  await Q.startFor(starter, { room: ROOM, keys: ["911", "912", "913"] });
  await goLive();
  const u = await mkUser();
  const r = await queueIt(u, "500");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.how, r.behind_queue, r.behind_left, r.place, r.line, r.behind], ["after", true, 2, 1, 1, "The Show — S1E1 Pilot"]);
  assert.ok(near(r.eta_sec, 3 * DUR - 80, 3 * DUR), "after the queue's three titles: " + r.eta_sec);
  assert.deepEqual(JSON.parse((await activeQ()).items).map((x) => x.key), ["911", "912", "913"], "nothing spliced into the starter's queue");
  const r2 = await queueIt(await mkUser(), "501");
  assert.deepEqual([r2.place, r2.line], [2, 2]);
  assert.ok(near(r2.eta_sec, 3 * DUR + 6780 - 80, 3 * DUR + 6780), "after the queue and the first one lined up: " + r2.eta_sec);
  await clear();
  await L.playFor(await mkUser(), { room: ROOM, key: "500" });
  await goLive();
  const st = await search(owner, "night");
  assert.deepEqual([st.state.library.can_replace, st.state.library.can_after, st.state.library.queue_as, !!st.state.library.slot_id], [true, true, "after", true],
                   "the pad's owner: both");
});

test("nothing on -> nothing_on; a live stream holding every slot of a 1-slot pad -> slot_taken (padState: no library, slot_taken); a queue still starting -> busy_queue, never nothing_on", async () => {
  const u = await mkUser();
  let r = await queueIt(u, "500", {}, OTHER);
  assert.deepEqual([r.ok, r.code], [false, "nothing_on"]);
  const live = await mkUser();
  const bk = await S.book(live, { minutes: 30, room: ONE });
  assert.equal((await pub(bk.key)).status, 302);
  r = await queueIt(u, "500", {}, ONE);
  assert.deepEqual([r.ok, r.code], [false, "slot_taken"], JSON.stringify(r));
  assert.match(r.error, /live on this pad's stage/);
  const st = await search(u, "charade", ONE);
  assert.deepEqual([st.state.library, st.state.slot_taken], [null, true]);
  await runQuery(`INSERT INTO media_queues (room_id, user_id, username, access, state, items, pos, prefs, scope, per_hour, paid_hours, played_sec, created, updated)
                  VALUES (?, ?, ?, 'free', 'starting', '[]', 0, '{}', 'list', 0, 0, 0, ?, ?)`, [OTHER, live.userId, live.username, T, T]);
  await assert.rejects(Q.after(u, { room: OTHER, key: "500" }), (e) => e.status === 409 && e.extra.code === "busy_queue");
  r = await queueIt(u, "500", {}, OTHER);
  assert.deepEqual([r.ok, r.code], [false, "busy_queue"]);
});

test("the line is full: line_full {max}; padState queue_as null + queue_why line_full; someone already in it still grows their own row", async () => {
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const us = [];
  for (let i = 0; i < Q.AFTER_MAX + 1; i++) us.push(await mkUser());
  for (let i = 0; i < Q.AFTER_MAX; i++) {
    const r = await queueIt(us[i], "501");
    assert.deepEqual([r.ok, r.place], [true, i + 1], JSON.stringify(r));
  }
  const r = await queueIt(us[Q.AFTER_MAX], "501");
  assert.deepEqual([r.ok, r.code, r.max], [false, "line_full", Q.AFTER_MAX]);
  const st = await search(us[Q.AFTER_MAX], "night");
  assert.deepEqual([st.state.library.queue_as, st.state.library.queue_why, st.state.library.can_after, st.state.library.line.full, st.state.library.line.count],
                   [null, "line_full", false, true, Q.AFTER_MAX]);
  const g = await queueIt(us[0], "502");
  assert.deepEqual([g.ok, g.place, g.items], [true, 1, 2]);
});

test("the speaker's rules: no points for the first title's started hours -> pat with need + have; an 18+ pad past its gate -> pad; queues off -> queue_off (padState queue_why)", async () => {
  await conf.set({ library_price: 50000 }, "test");
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const poor = await mkUser("pleb", 1000);
  let r = await queueIt(poor, "501", { estimate: 100000 });
  assert.deepEqual([r.ok, r.code, r.need, r.have], [false, "pat", 100000, 1000], JSON.stringify(r));
  const orig = PA.adultGate;
  PA.adultGate = () => "confirm";
  try {
    r = await queueIt(poor, "501", { estimate: 100000 });
    assert.deepEqual([r.ok, r.code], [false, "pad"], "the 18+ gate (fails closed) comes first");
  } finally { PA.adultGate = orig; }
  await conf.set({ library_queue: false }, "test");
  const st = await search(poor, "night");
  assert.deepEqual([st.state.library.queue_as, st.state.library.queue_why], [null, "queue_off"]);
  r = await queueIt(poor, "501", { estimate: 100000 });
  assert.deepEqual([r.ok, r.code], [false, "queue_off"]);
});

test("a booking due on the pad: no replace offered (can_replace false, no slot_id, booking_due), lining up still works - behind the booking", async () => {
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 20 * 60000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  const st = await search(owner, "carnival");
  const lib = st.state.library;
  assert.deepEqual([lib.can_replace, lib.slot_id, lib.booking_due && lib.booking_due.at, lib.queue_as], [false, undefined, bk.slot.start_at, "after"]);
  const r = await queueIt(owner, "502");
  assert.deepEqual([r.ok, r.how, r.place, r.line], [true, "after", 2, 2], JSON.stringify(r));
});

test("privacy: a chat line-up's audit row (pepe_after) is hidden from a plain starter's 📼 log, as the website's queue_after rows are; the pad's owner sees both", async () => {
  const starter = await mkUser();
  await L.playFor(starter, { room: ROOM, key: "500" });
  await goLive();
  const u = await mkUser();
  const r = await queueIt(u, "501");
  assert.equal(r.ok, true, JSON.stringify(r));
  const mine = (await L.player(starter, ROOM)).log.map((x) => x.action);
  assert.ok(!mine.includes("pepe_after") && !mine.includes("queue_after"), "a plain starter: " + JSON.stringify(mine));
  const theirs = (await L.player(owner, ROOM)).log.map((x) => x.action);
  assert.ok(theirs.includes("pepe_after") && theirs.includes("queue_after"), "the pad's owner: " + JSON.stringify(theirs));
});

test("an older bot: mode next / replace and plain plays answer as before; the new refusal codes are documented", async () => {
  for (const c of ["queue_on", "queue_held", "line_full", "line_next", "booking_next", "slot_taken"]) assert.ok(PC.CODES.includes(c), c);
  const starter = await mkUser();
  await L.playFor(starter, { room: ROOM, key: "500" });
  await goLive();
  const st = await search(starter, "night");
  assert.deepEqual([st.state.library.can_add, st.state.library.can_replace, st.state.library.starter_is_you, typeof st.state.library.slot_id],
                   [false, true, true, "string"], "the fields an older Pepe reads");
  let r = await call({ op: "play", as: asU(starter), room: ROOM, key: "501", scope: "title", mode: "next" });
  assert.deepEqual([r.ok, r.code], [false, "nothing_on"], "mode next on a single title: as before");
  r = await call({ op: "play", as: asU(starter), room: ROOM, key: "501", scope: "title", mode: "replace", replace_slot: st.state.library.slot_id });
  assert.deepEqual([r.ok, r.replaced && r.replaced.title], [true, "Charade (1963)"], JSON.stringify(r));
});
