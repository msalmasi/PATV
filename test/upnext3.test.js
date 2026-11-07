// upnext3 (1.99alm): the owner's answers of 2026-11-07 on the 📼 station break / "+ Add to the queue" against the REAL media-control service
// (deploy/mediactl, a mocked Plex + a fake ffmpeg) - the test/upnext2-fixes.test.js harness:
//   5   "Let someone add their own queue after someone else's queue." - a LINE behind a single title or a running queue: each person's own queue,
//       billed to them, first come first served (AFTER_MAX), handed over whenever the stage frees up; the 📼 player lists it (titles for all,
//       who + ✕ for whoever may take a row out)
//   7   "Start them instead." - ⏹ (in a break too), a Cut of that slot, a failed / lost start hand the stage to the line; ▶ Play this instead keeps
//       it waiting behind the new title; a cut of the whole pad / site, a cut + ban, a ban clear it
//   10  "Wait for that to finish." - a booked start due while something from the library is on waits for the title on now (a single title, its
//       break, a queue's title: the queue pauses and carries on after it as the SAME queue), at most the pad's 📼 limit after its time
//   TZ=UTC node --test test/upnext3.test.js
//   TZ=UTC node --test test/upnext2-fixes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upnext3-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SECRET = "b".repeat(48);
const PLEX_TOKEN = "plex-token-never-in-a-page-9a8b7c";
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

const media = path.join(tmp, "media");
fs.mkdirSync(media, { recursive: true });
const FILE = path.join(media, "secret-library-path.mkv");
fs.writeFileSync(FILE, "x");
const DUR = 2400;
const EPS = [["911", 1, 1, "Pilot"], ["912", 1, 2, "Second"], ["913", 1, 3, "Third"]];
const brief = ([key, season, episode, title]) => ({ key, type: "episode", title, show: "The Show", season, episode, duration: DUR, show_key: "900", season_key: "901", poster: true });
const plexFail = new Set();                                   // (a title media-control can't open any more: its start fails)
const plexDown = new Set();                                   // (review fixes: Plex unreachable for this title - media-control answers 502)
const plex = {
  async search() { return []; },
  async item(key) {
    if (plexFail.has(key)) { const err = new Error("Not in the Plex library"); err.status = 404; throw err; }
    if (plexDown.has(key)) { const err = new Error("Plex can't be reached right now"); err.status = 502; throw err; }
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
  p.finish = () => { p.dead = true; p.stdout.write(`out_time_us=${DUR * 1e6}\n`); setImmediate(() => p.emit("exit", 0, null)); };
  procs.push(p);
  return p;
}
// two encoders in all (the busyOf test asks for one more)
const mcfg = M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_MEDIA_ROOTS: media + path.sep, PLEX_TOKEN, MEDIACTL_MAX_STREAMS: "2" });
const mstreams = M.makeStreams(mcfg, plex, fakeSpawn, undefined, async () => null);
const { server } = M.makeServer(mcfg, { plex, streams: mstreams });

let T = Date.now();
S._setClock(() => T);
Q._setClock(() => T);
const adv = (ms) => { T += ms; };
let n = 0;
async function mkUser(cls = "pleb", balance = 0) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                 [id, "user" + n, "User " + n, cls, balance, "cf_user" + n]);
  return { userId: id, username: "user" + n, class: cls };
}
const ROOM = "Break.Room";
const OTHER = "Break.Other";
const THIRD = "Break.Third";
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const last = () => procs[procs.length - 1];
const keyOf = (p) => { const url = p.args[p.args.length - 1]; return url.slice(S.RTMP_PUBLIC.length + 1); };
let cids = 0;
async function pub(key) { const cid = String(++cids); const r = await S.rtmpCallback({ call: "publish", app: "stage", name: key, addr: "1.2.3.4", clientid: cid }); return { status: r.status, cid, key }; }
async function unpub(key, cid) { await S.rtmpCallback({ call: "publish_done", app: "stage", name: key, addr: "1.2.3.4", clientid: cid }); }
const VIEWER = { userId: "viewer-1", username: "viewer1", class: "pleb" };
const featured = async (room = ROOM) => { S.clearCache(); return S.featuredOf(room, VIEWER); };
const onEncoder = (room = ROOM) => { const x = mstreams.get(L.stageName(room)); return x && x.state === "playing" ? x : null; };
const running = () => mstreams.list().filter((x) => x.state === "playing");
const session = async (room = ROOM) => (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [room]))[0] || null;
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const play = async (id) => (await getQuery("SELECT * FROM media_plays WHERE id = ?", [id]))[0];
let admin, owner;
async function clear() {
  for (const q of await getQuery("SELECT id FROM media_queues WHERE state IN ('active','starting','after')")) await runQuery("UPDATE media_queues SET state = 'ended' WHERE id = ?", [q.id]);
  await runQuery("DELETE FROM media_sessions");
  mstreams.stopAll();
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  L._keys.clear();
  await S.setConfig({ takeover_mode: "when_idle", pepe_feature: null, pepe_feature_pads: {} }, "test");
  await conf.set({ library_price: 0, library_break: true, library_break_sec: 8 }, "test");
  for (const r of [ROOM, OTHER, THIRD]) await rooms.setStage(r, { upnext_break: "", slot_max_min: "" }, "test", { maxSlots: 4, maxPrice: 0, maxMinutes: 360 });
  await conf.set({ library_enabled: true, library_daily_cap: 50, library_free_daily_cap: 50 }, "test");
  plexFail.clear();
  plexDown.clear();
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
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, idle_grace_min: 5, enabled: true }, "test");
  await L.init();
  require(path.join(repo, "shop"));
  for (let i = 0; i < 100 && !(await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'shop_order_events'")).length; i++) await new Promise((r) => setTimeout(r, 20));
  admin = await mkUser("Admin");
  owner = await mkUser();
  for (const [r, t] of [[ROOM, "Break Pad"], [OTHER, "Other Pad"], [THIRD, "Third Pad"]]) await rooms.addRoom(r, t, "test");
  await runQuery("UPDATE rooms_registry SET owner_kind = 'user', owner_user_id = ? WHERE room_id = ?", [owner.userId, ROOM]);
  await rooms.loadCache();
  for (const r of [ROOM, OTHER, THIRD]) await rooms.setStage(r, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await conf.set({ library_enabled: true, library_plex: true, library_price: 0, library_daily_cap: 50, library_free_daily_cap: 50, library_queue_announce_min: 20 }, "test");
  golive.nowPlaying = async () => ({ announced: true });
});
test.afterEach(clear);
test.after(() => { mstreams.stopAll(); server.close(); });


// ───────────────────────── the reviews' findings (each failed on the reviewed build 559c2d08) ─────────────────────────


// ───────────────────────── upnext3 (1.99alm): the owner's answers of 2026-11-07, items 5 / 7 / 10 ─────────────────────────
const rowsOf = async (room = ROOM) => getQuery("SELECT * FROM media_queues WHERE room_id = ? AND state = 'after' ORDER BY id", [room]);
const activeQ = async (room = ROOM) => (await getQuery("SELECT * FROM media_queues WHERE room_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1", [room]))[0] || null;
const lastQ = async (u) => (await getQuery("SELECT * FROM media_queues WHERE user_id = ? ORDER BY id DESC LIMIT 1", [u.userId]))[0] || null;
const qRow = async (id) => (await getQuery("SELECT * FROM media_queues WHERE id = ?", [id]))[0] || null;
const inbox = async (u) => getQuery("SELECT title, body FROM inbox WHERE user_id = ? ORDER BY rowid", [u.userId]).catch(() => []);
const booking = async (slotId) => (await getQuery("SELECT * FROM media_bookings WHERE slot_id = ?", [slotId]))[0] || null;
const noBreak = (room = ROOM) => rooms.setStage(room, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
// the encoder that started last publishes (the slot goes live) / ends by itself (the watcher's next look hands over)
const goLive = () => pub(keyOf(last()));
async function endIt(p) { last().finish(); await settle(); if (p) await unpub(p.key, p.cid); await L.watch(); }

test("5 (\"Let someone add their own queue after someone else's queue\"): behind someone else's RUNNING queue viewers line up their OWN queues - first come first served (two at once: in order), at most AFTER_MAX people, a second + grows your own row; its starter grows the queue instead", async () => {
  await noBreak();
  const starter = await mkUser();
  await Q.startFor(starter, { room: ROOM, keys: ["912", "913"] });
  await goLive();
  const us = [];
  for (let i = 0; i < 6; i++) us.push(await mkUser());
  const m = await L.mine(us[0], ROOM);
  assert.deepEqual([m.on_pad.queue, m.on_pad.can_add, m.on_pad.can_after, m.on_pad.can_replace], [true, false, true, false], "+ Line up my queue - not + My list");
  const r1 = await Q.after(us[0], { room: ROOM, key: "500" });
  const r2 = await Q.after(us[1], { room: ROOM, key: "501" });
  const r3 = await Q.after(us[2], { room: ROOM, key: "502" });
  assert.deepEqual([r1.place, r2.place, r3.place, r3.line, r1.behind_queue, r1.behind], [1, 2, 3, 3, true, "The Show — S1E2 Second"]);
  const both = await Promise.all([Q.after(us[3], { room: ROOM, key: "911" }), Q.after(us[4], { room: ROOM, key: "500" })]);
  assert.deepEqual(both.map((x) => x.place).sort(), [4, 5], "two at once: one after the other (the pad's lock), never the same place");
  await assert.rejects(Q.after(us[5], { room: ROOM, key: "501" }), (e) => e.status === 409 && e.extra.code === "line_full" && e.extra.max === Q.AFTER_MAX);
  assert.equal(Q.AFTER_MAX, 5);
  assert.equal((await L.mine(us[5], ROOM)).on_pad.can_after, false, "a full line: + My list");
  const g = await Q.after(us[0], { room: ROOM, key: "502" });
  assert.deepEqual([g.place, g.items], [1, 2], "your own row grows - a full line doesn't stop that");
  const rows = await rowsOf();
  assert.deepEqual(rows.map((r) => r.user_id).slice(0, 3), us.slice(0, 3).map((u) => u.userId), "one row per person, each their own queue, in the order they came");
  assert.deepEqual(rows.map((r) => r.user_id).slice(3).sort(), [us[3].userId, us[4].userId].sort());
  assert.deepEqual(rows.slice(3).map((r) => r.user_id), both.slice().sort((a, b) => a.place - b.place).map((x) => rows.find((r) => r.id === x.queue_id).user_id), "places = the line's order");
  assert.ok(rows.every((r) => r.slot_id === null && r.state === "after"));
  const q = await activeQ();
  assert.deepEqual(JSON.parse(q.items).map((x) => x.key), ["912", "913"], "nothing spliced into the starter's queue");
  await assert.rejects(Q.after(starter, { room: ROOM, key: "501" }), (e) => e.status === 409 && e.extra.code === "queue_on", "its starter adds to it instead");
  assert.equal((await L.mine(starter, ROOM)).on_pad.can_add, true);
});

test("5: the running queue ends -> the first one lined up takes its slot over (the feature + the card carry, its station break), the rest wait behind THAT one; at the queue's last title the strip's UP NEXT is the line's head", async () => {
  await rooms.setStage(ROOM, { upnext_break: 5 }, "test", { maxSlots: 4, maxPrice: 0 });
  const t0 = T;
  const starter = await mkUser();
  await Q.startFor(starter, { room: ROOM, keys: ["912", "913"] });
  T = t0 + 5000; await L.watch();
  let p = await goLive();
  const u1 = await mkUser(), u2 = await mkUser();
  await Q.after(u1, { room: ROOM, key: "500" });
  await Q.after(u2, { room: ROOM, key: "501" });
  S.stageBump(ROOM);
  assert.equal((await S.comingOf(ROOM)).next.title, "Third", "the queue's own next title first");
  await endIt(p);                                                            // 912 ends -> 913's break
  T += 5000; await L.watch();
  p = await goLive();
  S.stageBump(ROOM);
  assert.equal((await S.comingOf(ROOM)).next.title, "Charade", "its last title: the line's head");
  const q0 = await activeQ();
  const t1 = T;
  await endIt(p);                                                            // 913 ends -> u1 takes the slot over
  const q1 = await activeQ();
  assert.equal(q1.user_id, u1.userId);
  const s0 = await S.getSlot(q0.slot_id);
  assert.deepEqual([s0.status, s0.end_reason], ["ended", "library_done"]);
  assert.equal((await qRow(q0.id)).end_reason, "finished");
  const f = await featured();
  assert.deepEqual([f.id, f.live, f.next.title], [q1.slot_id, false, "Charade"], "the new slot has the feature: the card");
  assert.equal((await Q.viewOf(await Q.activeFor(ROOM))).starts_at, t1 + 5000, "its own station break first");
  const rows = await rowsOf();
  assert.deepEqual([rows.length, rows[0].user_id, rows[0].behind], [1, u2.userId, q1.slot_id], "the rest wait behind the one that started");
  T = t1 + 5000; await L.watch();
  p = await goLive();
  await endIt(p);                                                            // Charade ends -> u2's
  assert.equal((await activeQ()).user_id, u2.userId);
  assert.equal((await rowsOf()).length, 0);
});

test("5: paid lines - every row bills its OWN owner as it plays; the queue in front running out of points hands over; a head without the points for its first title is skipped (a notice, nothing taken), the next one starts", async () => {
  await noBreak();
  await conf.set({ library_price: 1000 }, "test");
  const starter = await mkUser("pleb", 1000);                              // its first hour only
  await Q.startFor(starter, { room: ROOM, keys: ["912", "913"], estimate: 2000 });
  const p = await goLive();
  // (review fixes: lining up needs the points for its first title at the press - owner answer 3; this one spends them before its turn)
  const broke = await mkUser("pleb", 2000), payer = await mkUser("pleb", 5000);
  await Q.after(broke, { room: ROOM, key: "500", estimate: 2000 });
  await Q.after(payer, { room: ROOM, key: "501", estimate: 2000 });
  assert.deepEqual([await bal(broke), await bal(payer)], [2000, 5000], "nothing taken at the add");
  await runQuery("UPDATE users SET points_balance = 0 WHERE userId = ?", [broke.userId]);
  const q0 = await activeQ();
  await endIt(p);                                                            // 913 needs a 2nd hour: out of points -> hand over
  const ended = await qRow(q0.id);
  assert.deepEqual([ended.state, ended.notice], ["ended", "out_of_pat"]);
  assert.match(JSON.stringify(await inbox(starter)), /out of PAT/);
  const b = await lastQ(broke);
  assert.deepEqual([b.state, b.notice], ["ended", "after_cancelled"]);
  assert.match(JSON.stringify(await inbox(broke)), /takes 2,000 points/, "(review fixes: the notice says points)");
  assert.doesNotMatch(JSON.stringify(await inbox(broke)), /PAT/);
  const q = await activeQ();
  assert.equal(q.user_id, payer.userId, "the next one");
  assert.equal(onEncoder().ratingKey, "501");
  assert.deepEqual([await bal(starter), await bal(broke), await bal(payer)], [0, 0, 3000], "each paid only for their own titles");
  const plays = await getQuery("SELECT user_id, price FROM media_plays WHERE queue_id = ?", [q.id]);
  assert.ok(plays.length && plays.every((x) => x.user_id === payer.userId));
  assert.equal((await S.getSlot(q0.slot_id)).end_reason, "library_done");
});

test("5/7: media-control unreachable at a ⏹ - the walk stops, everyone keeps their place; it's back -> the head starts; a head held up past RETRY_MS is cancelled (a notice) and the next one starts", async () => {
  await noBreak();
  const u1 = await mkUser(), u2 = await mkUser();
  const down = async () => {
    const url = process.env.MEDIACTL_URL;
    process.env.MEDIACTL_URL = "http://127.0.0.1:9";
    try { await L.stop(admin, ROOM); } finally { process.env.MEDIACTL_URL = url; }
    mstreams.stop(L.stageName(ROOM));                                       // (its ffmpeg stopped meanwhile)
  };
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  await Q.after(u1, { room: ROOM, key: "501" });
  await Q.after(u2, { room: ROOM, key: "502" });
  await down();
  assert.equal(await session(), null, "what was on ended");
  let rows = await rowsOf();
  assert.deepEqual(rows.map((r) => r.user_id), [u1.userId, u2.userId], "both keep their place");
  assert.ok(rows[0].retry_since && !rows[1].retry_since);
  await L.watch();
  assert.equal((await activeQ()).user_id, u1.userId, "back: the head starts");
  await clear();
  await noBreak();
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  await Q.after(u1, { room: ROOM, key: "501" });
  await Q.after(u2, { room: ROOM, key: "502" });
  await down();
  T += 5 * 60 * 1000 + 1000;
  await L.watch();
  const c = await lastQ(u1);
  assert.deepEqual([c.state, c.notice], ["ended", "after_cancelled"]);
  assert.match(JSON.stringify(await inbox(u1)), /no library stream came free in time/);
  assert.equal((await activeQ()).user_id, u2.userId);
});

test("7 (\"Start them instead.\"): ⏹ of a paid play in its own station break - its hold comes back once, it counts once on its starter's cap (S3), and the next in line takes the stage: its own break, then its title, charged then", async () => {
  await conf.set({ library_price: 1000, library_daily_cap: 5 }, "test");
  const u = await mkUser("pleb", 100000), nxt = await mkUser("pleb", 100000);
  const a = await L.playFor(u, { room: ROOM, key: "501", price: 2000 });
  await Q.after(nxt, { room: ROOM, key: "502", estimate: 2000 });
  T += 3000;
  const t1 = T;
  const r = await L.stop(u, ROOM);
  assert.equal(r.next_started, true);
  assert.equal(await bal(u), 100000, "refunded once");
  assert.equal(await L.paidToday(u.userId), 1, "S3: counted once");
  assert.equal((await play(a.play_id)).charge, "refunded");
  const sa = await S.getSlot(a.slot.id);
  assert.deepEqual([sa.end_reason, sa.ended_by], ["library_stopped", u.username]);
  const q = await activeQ();
  assert.equal(q.user_id, nxt.userId);
  assert.equal((await Q.viewOf(await Q.activeFor(ROOM))).starts_at, t1 + 8000, "its own 8 s break");
  assert.equal(running().length, 0, "no encoder in the break");
  assert.equal((await featured()).id, q.slot_id, "the card is the pad's stage");
  assert.equal(await bal(nxt), 100000);
  T = t1 + 8000; await L.breakDue(ROOM);
  assert.equal(onEncoder().ratingKey, "502");
  assert.equal(await bal(nxt), 98000, "its own first hours, as it starts");
  assert.equal(await bal(u), 100000);
});

test("7 neighbours: a queue's ⏹ starts what's lined up (the swap); ▶ Play this instead over a queue keeps them waiting behind the new title; a Cut of that slot starts them on a fresh slot; a cut + ban / a cut of the whole pad / a ban clears them", async () => {
  const fresh = async () => { await clear(); await noBreak(); await Q.startFor(admin, { room: ROOM, keys: ["912", "913"] }); await goLive(); };
  const u1 = await mkUser();
  await fresh();
  await Q.after(u1, { room: ROOM, key: "501" });
  let q0 = await activeQ();
  await L.stop(admin, ROOM);
  assert.equal((await activeQ()).user_id, u1.userId, "⏹: they start");
  assert.equal((await qRow(q0.id)).end_reason, "stopped by " + admin.username);
  assert.equal((await S.getSlot(q0.slot_id)).end_reason, "library_stopped");
  await fresh();
  await Q.after(u1, { room: ROOM, key: "501" });
  const rp = await L.playFor(admin, { room: ROOM, key: "500", replace: true });
  let rows = await rowsOf();
  assert.deepEqual([rows.length, rows[0].behind], [1, rp.slot.id], "replaced: they wait behind the new title");
  assert.equal(await activeQ(), null);
  await fresh();
  await Q.after(u1, { room: ROOM, key: "501" });
  q0 = await activeQ();
  await S.end(q0.slot_id, "cut", owner.username);                           // a Cut of that one slot
  await L.watch();
  const q1 = await activeQ();
  assert.ok(q1 && q1.user_id === u1.userId && q1.slot_id !== q0.slot_id, "a Cut of one play: they start, on a fresh slot");
  for (const how of ["ban", "pad", "banned"]) {
    await fresh();
    await Q.after(u1, { room: ROOM, key: "501" });
    q0 = await activeQ();
    if (how === "banned") await S.end(q0.slot_id, "banned", owner.username);
    else await S.end(q0.slot_id, "cut", owner.username, { scope: how });
    await L.watch();
    assert.equal(await activeQ(), null, how + ": nothing starts");
    assert.equal((await rowsOf()).length, 0);
    assert.equal((await lastQ(u1)).notice, "after_cancelled", how);
  }
  // the routes say how far a cut reaches
  const src = fs.readFileSync(path.join(repo, "mainstage.js"), "utf8");
  assert.match(src, /const scope = banSlot \? "ban" : b\.id \? null : "pad";/);
  assert.match(src, /end\(s\.id, "cut", actor\(req\), \{ scope: b\.ban && s\.source !== "cam" \? "ban" : null \}\)/);
  assert.match(src, /"pepe:" \+ String\(b\.by \|\| "bot"\)\.slice\(0, 40\), \{ scope: "pad" \}\)/);
  assert.match(fs.readFileSync(path.join(repo, "roomsweb.js"), "utf8"), /stage\.end\(id, "cut", who, \{ scope: s \? null : "pad" \}\)/);
});

test("10 (\"Wait for that to finish.\"): a booked start whose time comes while a single title plays WAITS (its booker told once; the schedule, Your bookings and the sheet say so; ▶ Play this instead / a fresh ▶ are refused booking_next, lining up still works) - the title ends -> the booking takes the stage over on ITS booked slot (the feature carries)", async () => {
  await noBreak();
  const a = await L.playFor(admin, { room: ROOM, key: "500" });
  const p = await goLive();
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 20 * 60000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  const b = await booking(bk.slot.id);
  assert.deepEqual([b.state, b.wait_for], ["waiting", "Charade (1963)"]);
  assert.match(JSON.stringify(await inbox(booker)), /waits for the current title to finish/);
  await L.watch();
  assert.equal((await inbox(booker)).length, 1, "told once");
  const sch = await S.roomSchedule(ROOM, VIEWER, false);
  // (review ux 12: + ends_at - the "ux 12" test below)
  assert.equal(sch.upcoming.find((x) => x.lib_wait).lib_wait.title, "Charade (1963)");
  assert.equal((await S.mine(booker.userId)).slots.find((x) => x.id === bk.slot.id).lib_wait.title, "Charade (1963)");
  assert.equal((await S.roomStage(ROOM, VIEWER)).upcoming.find((x) => x.id === bk.slot.id).lib_wait.title, "Charade (1963)");
  await assert.rejects(L.playFor(admin, { room: ROOM, key: "502", replace: true }), (e) => e.status === 409 && e.extra.code === "booking_next");
  const m = await L.mine(admin, ROOM);
  assert.deepEqual([m.on_pad.can_replace, m.on_pad.booking.at], [false, bk.slot.start_at]);
  const u = await mkUser();
  const lu = await Q.after(u, { room: ROOM, key: "502" });
  assert.equal(lu.place, 2, "behind the booking");
  S.stageBump(ROOM);
  assert.equal((await S.comingOf(ROOM)).next.title, "Night of the Living Dead", "UP NEXT: the booking");
  const pl = await L.player(VIEWER, ROOM);
  assert.deepEqual(pl.line.map((x) => x.kind), ["booking", "after"]);
  assert.equal(pl.line[0].at, bk.slot.start_at);
  await endIt(p);
  const q = await activeQ();
  assert.deepEqual([q.user_id, q.slot_id], [booker.userId, bk.slot.id], "its own booked slot");
  assert.deepEqual([(await booking(bk.slot.id)).state, (await booking(bk.slot.id)).queue_id], ["started", q.id]);
  assert.equal((await S.getSlot(a.slot.id)).end_reason, "library_done");
  assert.equal((await featured()).id, bk.slot.id, "the feature carried");
  assert.equal(onEncoder().ratingKey, "501");
  assert.equal((await rowsOf())[0].behind, bk.slot.id, "the line waits behind it");
  // nothing on and a booking due: a fresh ▶ goes after it
  const booker2 = await mkUser();
  const bk2 = await Q.bookFor(booker2, { room: OTHER, key: "502", start_at: T + 5 * 60000 });
  T = bk2.slot.start_at + 1000;
  await assert.rejects(L.playFor(admin, { room: OTHER, key: "500" }), (e) => e.status === 409 && e.extra.code === "booking_next");
});

test("10: due during a single title's station break - it waits for that title (its break, the title), then starts after it", async () => {
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 3 * 60000 });
  T = bk.slot.start_at - 2000;
  await L.playFor(admin, { room: ROOM, key: "500" });                      // its 8 s break, before the booking's time
  T += 3000; await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "waiting");
  T += 6000; await L.watch();                                                // the break is over: the title starts - the booking still waits
  assert.equal((await session()).state, "playing");
  assert.equal(onEncoder().ratingKey, "500");
  assert.equal((await booking(bk.slot.id)).state, "waiting");
  const p = await goLive();
  const t1 = T;
  await endIt(p);
  const q = await activeQ();
  assert.deepEqual([q.user_id, q.slot_id], [booker.userId, bk.slot.id]);
  assert.equal((await Q.viewOf(await Q.activeFor(ROOM))).starts_at, t1 + 8000, "its station break");
});

test("10: due during a running queue - it waits for the title on now, then plays at the title change; the queue PAUSES and carries on right after it as the SAME queue (its paid hours, what it played, ONE daily play), from the next title", async () => {
  await noBreak();
  await conf.set({ library_price: 1000, library_daily_cap: 1 }, "test");
  const starter = await mkUser("pleb", 100000);
  await Q.startFor(starter, { room: ROOM, keys: ["911", "912", "913"], estimate: 2000 });
  let p = await goLive();
  const q0 = await activeQ();
  assert.equal(q0.paid_hours, 1);
  const booker = await mkUser("pleb", 100000);
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 5 * 60000, estimate: 2000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "waiting");
  S.stageBump(ROOM);
  assert.equal((await S.comingOf(ROOM)).next.title, "Night of the Living Dead", "the booking plays next - ahead of the queue's next title");
  await endIt(p);                                                            // 911 ends: the booking's moment
  const held = await qRow(q0.id);
  assert.deepEqual([held.state, held.pos, held.slot_id, held.notice, held.resume != null], ["after", 1, null, "held", true]);
  assert.match(JSON.stringify(await inbox(starter)), /pauses for a booked stream/);
  const qb = await activeQ();
  assert.deepEqual([qb.user_id, qb.slot_id], [booker.userId, bk.slot.id]);
  assert.equal((await S.getSlot(q0.slot_id)).end_reason, "library_done");
  assert.equal(onEncoder().ratingKey, "501");
  assert.equal(await bal(booker), 98000);
  const pl = await L.player(VIEWER, ROOM);
  assert.deepEqual([pl.line[0].kind, pl.line[0].next[0].title, pl.line[0].count], ["resume", "Second", 2]);
  const mv = (await Q.views({ userId: starter.userId })).find((x) => x.id === q0.id);
  assert.equal(mv.held, true);
  await assert.rejects(Q.after(starter, { room: ROOM, key: "500", estimate: 2000 }), (e) => e.extra.code === "queue_held");
  p = await goLive();
  await endIt(p);                                                            // the booking ends: the queue carries on
  const q1 = await activeQ();
  assert.equal(q1.id, q0.id, "the same queue");
  assert.notEqual(q1.slot_id, q0.slot_id);
  assert.equal(q1.pos, 1);
  assert.equal(onEncoder().ratingKey, "912");
  assert.equal(q1.played_sec, 2400, "what it played");
  assert.equal(q1.paid_hours, 2, "its paid hour kept; the 2nd started hour as 912 starts");
  assert.equal(await bal(starter), 98000);
  assert.equal(await L.paidToday(starter.userId), 1, "one daily play (its cap is 1: carrying on wasn't refused)");
  assert.equal((await booking(bk.slot.id)).state, "started");
});

test("10: a booking waits at most the pad's 📼 limit after its time - the stage's own backstop leaves a waiting one alone until then; past it, it fails (a notice, nothing taken)", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0, slot_max_min: 130 }, "test", { maxSlots: 4, maxPrice: 0, maxMinutes: 360 });
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 5 * 60000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "waiting");
  assert.match(JSON.stringify(await inbox(booker)), /up to 2 h after its time/);
  T = bk.slot.start_at + 20 * 60000;
  const s = await session();
  await runQuery("UPDATE stage_slots SET beat = ?, publishing = 1 WHERE id = ?", [T, s.slot_id]);   // (the title is still live)
  await S.tick();
  assert.equal((await S.getSlot(bk.slot.id)).status, "scheduled", "not 'no_room' while it waits");
  T = bk.slot.start_at + 131 * 60000;
  await L.watch();
  const b = await booking(bk.slot.id);
  assert.equal(b.state, "failed");
  assert.match(b.error, /didn't finish in time/);
  assert.equal((await S.getSlot(bk.slot.id)).status, "ended");
  assert.match(JSON.stringify(await inbox(booker)), /didn't start/);
  assert.equal(await bal(booker), 0);
});

test("5: the 📼 player lists who's lined up, in order - titles for everyone; who and ✕ only for whoever may take that row out; ✕ by id takes out exactly that row (the pad's owner: someone else's, with a notice)", async () => {
  await noBreak();
  await Q.startFor(admin, { room: ROOM, keys: ["912", "913"] });
  await goLive();
  const u1 = await mkUser(), u2 = await mkUser();
  await Q.after(u1, { room: ROOM, key: "500" });
  await Q.after(u2, { room: ROOM, key: "501" });
  const pv = await L.player(VIEWER, ROOM);
  assert.deepEqual(pv.line.map((x) => [x.kind, x.next[0].title, x.mine, x.can_withdraw, "by" in x]), [["after", "Charade", false, false, false], ["after", "Night of the Living Dead", false, false, false]]);
  assert.equal("by" in (await L.player(null, ROOM)).line[0], false, "signed out: no names");
  const p2 = await L.player(u2, ROOM);
  assert.deepEqual([p2.line[0].mine, "by" in p2.line[0], p2.line[1].mine, p2.line[1].can_withdraw, p2.line[1].by], [false, false, true, true, u2.username]);
  const po = await L.player(owner, ROOM);
  assert.ok(po.line.every((x) => x.can_withdraw && x.by), "the pad's owner");
  await assert.rejects(Q.withdrawAfter(u2, ROOM, p2.line[0].id), (e) => e.status === 403 && e.extra.code === "control_denied");
  await Q.withdrawAfter(owner, ROOM, po.line[1].id);
  assert.deepEqual((await rowsOf()).map((r) => r.user_id), [u1.userId], "exactly that row");
  assert.equal((await lastQ(u2)).notice, "after_removed");
  assert.match(JSON.stringify(await inbox(u2)), /were taken out/);
  await Q.withdrawAfter(u1, ROOM);                                           // (no id: your own)
  assert.equal((await rowsOf()).length, 0);
  assert.equal((await inbox(u1)).length, 0);
});

test("restart windows: a queue still 'starting' on the pad - the line waits for it; one that never finished starting (2 min) ends and the line's head starts", async () => {
  await noBreak();
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const u1 = await mkUser();
  await Q.after(u1, { room: ROOM, key: "501" });
  await L.stop(admin, ROOM);                                                 // u1's queue is on now
  const q = await activeQ();
  await runQuery("UPDATE media_queues SET state = 'starting', updated = ? WHERE id = ?", [T, q.id]);   // (the process died before 'active')
  const u2 = await mkUser();
  await runQuery(`INSERT INTO media_queues (room_id, user_id, username, access, state, items, pos, prefs, scope, per_hour, paid_hours, played_sec, slot_id, created, updated, behind)
                  VALUES (?, ?, ?, 'paid', 'after', ?, 0, ?, 'list', 0, 0, 0, NULL, ?, ?, ?)`,
                 [ROOM, u2.userId, u2.username, JSON.stringify([{ key: "502", type: "movie", title: "Carnival of Souls", year: 1962, duration: 4680 }]), JSON.stringify({ req: {}, est: 0 }), T, T, q.slot_id]);
  await L.watch();
  assert.equal((await rowsOf()).length, 1, "the line waits for it");
  assert.equal((await qRow(q.id)).state, "starting");
  T += 2 * 60000 + 1000;
  await L.watch();
  assert.equal((await qRow(q.id)).state, "ended");
  assert.equal((await S.getSlot(q.slot_id)).end_reason, "library_failed");
  assert.equal((await activeQ()).user_id, u2.userId, "the line's head starts");
});


// ───────────────────────── upnext3 review fixes (1.99alm): the money review (1-7 + smaller notes) and the UX review (1-13) - each failed on 792ccd1b ─────────────────────────
const DEAD = "http://127.0.0.1:9";
async function mcDown(fn) { const url = process.env.MEDIACTL_URL; process.env.MEDIACTL_URL = DEAD; try { return await fn(); } finally { process.env.MEDIACTL_URL = url; } }
const blip = async () => { throw new L.Refuse(503, "The Plex player can't be reached right now - try again in a bit.", { code: "encoder_down" }); };

test("money 1: the next in line held up by a busy media-control - a fresh ▶ / a queue start is refused line_next (the line goes first); a re-park behind what came on clears its retry clock (never cancelled later while it waits)", async () => {
  await noBreak();
  const u1 = await mkUser(), u3 = await mkUser(), booker = await mkUser();
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "502", start_at: T + 3 * 60000 });
  await Q.after(u1, { room: ROOM, key: "501" });
  T = bk.slot.start_at - 10000;
  await mcDown(() => L.stop(admin, ROOM));                                   // ⏹ while media-control blips: the hand-over is held up
  mstreams.stop(L.stageName(ROOM));
  assert.equal(await session(), null);
  assert.ok((await rowsOf())[0].retry_since, "held up");
  await assert.rejects(L.playFor(u3, { room: ROOM, key: "502" }), (e) => e.status === 409 && e.extra.code === "line_next");
  await assert.rejects(Q.startFor(u3, { room: ROOM, keys: ["911", "912"] }), (e) => e.status === 409 && e.extra.code === "line_next");
  T = bk.slot.start_at + 1000;
  await L.watch();                                                           // media-control back + the booking due: it goes first
  const q = await activeQ();
  assert.equal(q && q.user_id, booker.userId);
  const rows = await rowsOf();
  assert.deepEqual([rows.length, rows[0].behind, rows[0].retry_since], [1, q.slot_id, null], "re-parked behind the booking, its retry clock cleared");
  T += 6 * 60000;
  await L.watch();
  assert.equal((await lastQ(u1)).state, "after", "still in line - not 'no library stream came free in time'");
});

test("money 2: a waiting booking's start window counts from when the stage really came free - a failed yield at a queue's title change (the queue kept the stage) never starts the clock; later, held up again, it waits out its window and starts", async () => {
  await noBreak();
  await Q.startFor(admin, { room: ROOM, keys: ["911", "912"] });
  let p = await goLive();
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 5 * 60000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "waiting");
  const orig = L._q.needEncoder;
  L._q.needEncoder = blip;
  try { await endIt(p); } finally { L._q.needEncoder = orig; }               // 911 ends = the booking's moment; the yield fails for now
  assert.equal(onEncoder().ratingKey, "912", "the queue went on");
  assert.equal((await booking(bk.slot.id)).free_at, null, "the stage never came free for it");
  p = await goLive();
  T += 40 * 60000;
  L._q.needEncoder = blip;
  try {
    await L.stop(admin, ROOM);
    assert.equal(await activeQ(), null);
    T += 10000;
    await L.watch();
    assert.equal((await booking(bk.slot.id)).state, "waiting", "inside its start window from when the stage came free");
  } finally { L._q.needEncoder = orig; }
  T += 10000;
  await L.watch();
  const q = await activeQ();
  assert.deepEqual([q && q.user_id, (await booking(bk.slot.id)).state], [booker.userId, "started"]);
});

test("money 3: a booking never starts for more than the estimate its booker said yes to - the price rose while it waited: it doesn't start (a notice in points, nothing taken); a price that fell starts it at the lower price", async () => {
  await noBreak();
  await conf.set({ library_price: 1000 }, "test");
  const booker = await mkUser("pleb", 100000);
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 5 * 60000, estimate: 2000 });
  await conf.set({ library_price: 5000 }, "test");
  T = bk.slot.start_at + 1000;
  await L.watch();
  assert.equal(await activeQ(), null);
  const b = await booking(bk.slot.id);
  assert.equal(b.state, "failed");
  assert.match(b.error, /about 10,000 points now - more than the 2,000 points you said yes to when you booked it/);
  assert.equal(await bal(booker), 100000, "nothing taken");
  assert.match(JSON.stringify(await inbox(booker)), /more than the 2,000 points you said yes to/);
  await conf.set({ library_price: 1000 }, "test");
  const bk2 = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 5 * 60000, estimate: 2000 });
  await conf.set({ library_price: 500 }, "test");
  T = bk2.slot.start_at + 1000;
  await L.watch();
  const q = await activeQ();
  assert.deepEqual([q && q.user_id, q && q.per_hour], [booker.userId, 500]);
  assert.equal(await bal(booker), 100000 - 1000, "its first title at the lower price");
});

test("money 4: a cut of the whole pad that lands half-way through a hand-over stops the walk - nobody else lined up starts on the pad that was just cleared, each is told it was cleared", async () => {
  await noBreak();
  await L.playFor(admin, { room: ROOM, key: "500" });
  const p = await goLive();
  const u1 = await mkUser(), u2 = await mkUser();
  const a1 = await Q.after(u1, { room: ROOM, key: "501" });
  const a2 = await Q.after(u2, { room: ROOM, key: "502" });
  const orig = Q.moveAfter;
  let fired = false;
  Q.moveAfter = async (room, from, to) => {                                  // (retire calls it right after the swap committed)
    if (!fired) {
      fired = true;
      for (const s of await getQuery("SELECT id FROM stage_slots WHERE room_id = ? AND status IN ('waiting','active')", [ROOM])) await S.end(s.id, "cut", owner.username, { scope: "pad" });
    }
    return orig(room, from, to);
  };
  try { await endIt(p); } finally { Q.moveAfter = orig; }
  assert.ok(fired);
  assert.equal(await activeQ(), null, "nobody starts on the cleared pad");
  assert.equal((await rowsOf()).length, 0);
  for (const [u, a] of [[u1, a1], [u2, a2]]) {
    const r = await qRow(a.queue_id);
    assert.deepEqual([r.state, r.notice], ["ended", "after_cancelled"]);
    assert.match(JSON.stringify(await inbox(u)), /was cut and the stage cleared/);
  }
});

test("money 5: a queue paused for a booking that can't carry on (its wait cap) says plainly that the unused part of the hour it paid for isn't refunded", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0, slot_max_min: 130 }, "test", { maxSlots: 4, maxPrice: 0, maxMinutes: 360 });
  await conf.set({ library_price: 1000 }, "test");
  const starter = await mkUser("pleb", 100000);
  await Q.startFor(starter, { room: ROOM, keys: ["911", "912"], estimate: 2000 });
  const p = await goLive();
  const q0 = await activeQ();
  const booker = await mkUser("pleb", 100000);
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 5 * 60000, estimate: 2000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  await endIt(p);                                                            // 911 ends -> the booking plays, q0 pauses
  await goLive();
  T += 131 * 60000;
  await runQuery("UPDATE media_sessions SET updated = ?", [T]);
  await L.watch();
  const h = await qRow(q0.id);
  assert.deepEqual([h.state, h.notice], ["ended", "held_cancelled"]);
  const box = JSON.stringify(await inbox(starter));
  assert.match(box, /didn't carry on/);
  assert.match(box, /the 20 minutes left of the hour it had paid for aren't refunded/);
});

test("money 6: a booking is marked started inside its own start, before its first title goes out (a restart half-way never leaves it 'waiting' for a stream that played); a start that then fails puts it back, so it fails with a notice", async () => {
  await noBreak();
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 3 * 60000 });
  T = bk.slot.start_at + 1000;
  const orig = S.libraryRetitle;
  let seen = null;
  S.libraryRetitle = async (...a) => { seen = (await booking(bk.slot.id)).state; return orig(...a); };
  try { await L.watch(); } finally { S.libraryRetitle = orig; }
  assert.equal(seen, "started");
  assert.equal((await booking(bk.slot.id)).queue_id, (await activeQ()).id);
  await clear();
  await noBreak();
  const bk2 = await Q.bookFor(booker, { room: ROOM, key: "502", start_at: T + 3 * 60000 });
  T = bk2.slot.start_at + 1000;
  S.libraryRetitle = async () => { throw new Error("boom"); };
  try { await L.watch(); } finally { S.libraryRetitle = orig; }
  const b2 = await booking(bk2.slot.id);
  assert.deepEqual([b2.state, b2.error, b2.queue_id], ["failed", "boom", null]);
  assert.match(JSON.stringify(await inbox(booker)), /didn't start/);
});

test("money 7: the booked slot's own refusals carry codes (site_full, busy_library) - a full site holds a booking up inside its start window instead of failing it at once", async () => {
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 3 * 60000 });
  await S.setConfig({ max_concurrent: 1 }, "test");
  try {
    await L.playFor(admin, { room: OTHER, key: "500" });
    T = bk.slot.start_at + 1000;
    await assert.rejects(S.libraryActivate(bk.slot.id, { title: "📼 x", minutes: 100 }), (e) => e.status === 409 && e.code === "site_full");
    await L.watch();
    assert.equal((await booking(bk.slot.id)).state, "booked", "held up, not failed");
    assert.equal((await S.getSlot(bk.slot.id)).status, "scheduled");
  } finally { await S.setConfig({ max_concurrent: 6 }, "test"); }
  T += 10000;
  await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "started", "room again: it starts");
  assert.match(fs.readFileSync(path.join(repo, "mainstage.js"), "utf8"), /already playing something from the library\.", "busy_library"\)/);
});

test("money (smaller): Plex / media-control answering 5xx when a queue's next title is fetched - it waits and tries that title again, never skips it", async () => {
  await noBreak();
  await Q.startFor(admin, { room: ROOM, keys: ["911", "912"] });
  const p = await goLive();
  const q0 = await activeQ();
  plexDown.add("912");
  await endIt(p);
  const q = await qRow(q0.id);
  assert.deepEqual([q.state, q.pos, q.fails], ["active", 1, 0]);
  assert.ok(q.retry_since, "waits");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM media_plays WHERE queue_id = ? AND error IS NOT NULL", [q0.id]))[0].n, 0, "no skipped title");
  plexDown.clear();
  await L.watch();
  assert.equal(onEncoder().ratingKey, "912");
});

test("money (smaller) + owner answer 3: lining up a paid queue needs the points for its first title's started hours at the press (nothing is taken) - empty accounts can't fill the line", async () => {
  await noBreak();
  await conf.set({ library_price: 1000 }, "test");
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const short = await mkUser("pleb", 1999), ok = await mkUser("pleb", 2000);
  await assert.rejects(Q.after(short, { room: ROOM, key: "501", estimate: 2000 }),
                       (e) => e.status === 402 && e.extra.code === "pat" && e.extra.need === 2000 && /2,000 points/.test(e.message) && !/\bPAT\b/.test(e.message));
  const r = await Q.after(ok, { room: ROOM, key: "501", estimate: 2000 });
  assert.equal(r.place, 1);
  assert.equal(await bal(ok), 2000, "nothing taken");
  assert.equal((await rowsOf()).length, 1);
});

test("ux 1 (privacy): the 'Who did what' log of a plain starter keeps only their own line-up entries - who else lined up, or was taken out, only for the pad's owner / an admin", async () => {
  await noBreak();
  const starter = await mkUser(), willow = await mkUser(), me = await mkUser();
  await Q.startFor(starter, { room: ROOM, keys: ["912", "913"] });
  await goLive();
  await Q.after(willow, { room: ROOM, key: "500" });
  await Q.after(me, { room: ROOM, key: "501" });
  await Q.withdrawAfter(owner, ROOM, (await rowsOf())[1].id);
  const ps = await L.player(starter, ROOM);
  assert.equal(ps.can_control, true);
  assert.ok(!ps.log.some((l) => ["queue_after", "queue_remove"].includes(l.action)), JSON.stringify(ps.log));
  for (const u of [willow, me]) assert.ok(!JSON.stringify(ps.log).includes(u.username), u.username);
  const po = await L.player(owner, ROOM);
  const theirs = (log) => log.filter((l) => l.action === "queue_after" && [willow.username, me.username].includes(l.username)).length;
  assert.equal(theirs(po.log), 2);
  assert.ok(po.log.some((l) => l.action === "queue_remove" && l.username === owner.username));
  assert.equal(theirs((await L.player(admin, ROOM)).log), 2);
  assert.ok(!("user_id" in po.log[0]), "no ids out");
});

test("ux 2: 'Coming up' says how many are lined up, whether a booking is first and how many a cleared stage would keep, whenever anyone is - a queue that still has titles included", async () => {
  await noBreak();
  await Q.startFor(admin, { room: ROOM, keys: ["911", "912", "913"] });
  await goLive();
  const u1 = await mkUser(), u2 = await mkUser(), booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "502", start_at: T + 3 * 60000 });
  await Q.after(u1, { room: ROOM, key: "500" });
  await Q.after(u2, { room: ROOM, key: "501" });
  S.stageBump(ROOM);
  let c = await S.comingOf(ROOM);
  assert.equal(c.next.title, "Second", "the queue's own next title");
  assert.deepEqual([c.line, c.line_head, c.line_kept, c.queued], [2, "after", 0, undefined]);
  T = bk.slot.start_at + 1000;
  await L.watch();
  S.stageBump(ROOM);
  c = await S.comingOf(ROOM);
  assert.deepEqual([c.line, c.line_head, c.line_kept, c.queued, c.next.title], [3, "booking", 1, true, "Carnival of Souls"]);
});

test("ux 3: a cut + ban of one title cancels only the picks lined up behind it - a booking that waited starts on the free stage; a queue paused for a booking carries on when the booking is cut + banned; a cut of the whole pad ends a paused queue too, never a booking", async () => {
  await noBreak();
  const troll = await mkUser(), u1 = await mkUser(), booker = await mkUser();
  await L.playFor(troll, { room: ROOM, key: "500" });
  await goLive();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 3 * 60000 });
  await Q.after(u1, { room: ROOM, key: "502" });
  T = bk.slot.start_at + 1000;
  await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "waiting");
  await S.end((await session()).slot_id, "cut", owner.username, { scope: "ban" });
  await L.watch();
  const c1 = await lastQ(u1);
  assert.deepEqual([c1.state, c1.notice], ["ended", "after_cancelled"], "the pick behind it is cancelled");
  let q = await activeQ();
  assert.deepEqual([q && q.user_id, q && q.slot_id, (await booking(bk.slot.id)).state], [booker.userId, bk.slot.id, "started"], "the booking starts");
  assert.doesNotMatch(JSON.stringify(await inbox(booker)), /didn't start/);
  for (const scope of ["ban", "pad"]) {
    await clear();
    await noBreak();
    const starter = await mkUser(), bkr = await mkUser();
    await Q.startFor(starter, { room: ROOM, keys: ["911", "912"] });
    const p = await goLive();
    const q0 = await activeQ();
    const b2 = await Q.bookFor(bkr, { room: ROOM, key: "501", start_at: T + 3 * 60000 });
    T = b2.slot.start_at + 1000;
    await L.watch();
    await endIt(p);                                                          // the booking plays, q0 pauses
    assert.equal((await qRow(q0.id)).state, "after");
    await goLive();
    await S.end(b2.slot.id, "cut", owner.username, { scope });
    await L.watch();
    q = await qRow(q0.id);
    if (scope === "ban") assert.deepEqual([q.state, (await activeQ()).id], ["active", q0.id], "cut + ban of the booking: the paused queue carries on");
    else assert.deepEqual([q.state, q.notice], ["ended", "held_cancelled"], "a cut of the whole pad: it ends too");
  }
});

test("ux 5: whoever was lined up is told when their queue starts (paid: about how many points, charged as it plays; ⏹ in the 📼 player)", async () => {
  await noBreak();
  await conf.set({ library_price: 1000 }, "test");
  await L.playFor(admin, { room: ROOM, key: "500" });
  const p = await goLive();
  const u1 = await mkUser("pleb", 100000);
  await Q.after(u1, { room: ROOM, key: "501", estimate: 2000 });
  assert.equal((await inbox(u1)).length, 0);
  await endIt(p);
  assert.equal((await activeQ()).user_id, u1.userId);
  const box = await inbox(u1);
  assert.equal(box.length, 1);
  assert.match(box[0].title, /Your queue on Break Pad is starting/);
  assert.match(box[0].body, /“Night of the Living Dead \(1968\)” is on now - about 2,000 points in all, charged as it plays \(only what actually plays\)\. ⏹ in the pad's 📼 player stops it\./);
});

test("ux 7: a full line says so - the sheet's answer flags line_full for someone who isn't in it", async () => {
  await noBreak();
  await Q.startFor(admin, { room: ROOM, keys: ["912", "913"] });
  await goLive();
  const us = [];
  for (let i = 0; i < 6; i++) us.push(await mkUser());
  for (let i = 0; i < 5; i++) await Q.after(us[i], { room: ROOM, key: "500" });
  const m = (await L.mine(us[5], ROOM)).on_pad;
  assert.deepEqual([m.can_after, m.line_full, m.line_max], [false, true, 5]);
  assert.equal("line_full" in (await L.mine(us[0], ROOM)).on_pad, false, "in it: your own row grows");
});

test("ux 8 / 13: the player says whether the pad has a station break (the ⏹ confirm), and a paused queue's row says whether it was paid (its take-out confirm) to whoever may take it out", async () => {
  await conf.set({ library_price: 1000 }, "test");
  await noBreak();
  const starter = await mkUser("pleb", 100000);
  await Q.startFor(starter, { room: ROOM, keys: ["911", "912"], estimate: 2000 });
  const p = await goLive();
  assert.equal((await L.player(starter, ROOM)).station_break, false);
  const booker = await mkUser("pleb", 100000);
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 3 * 60000, estimate: 2000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  await endIt(p);
  const po = await L.player(owner, ROOM), pv = await L.player(VIEWER, ROOM);
  assert.deepEqual([po.line[0].kind, po.line[0].paid, "paid" in pv.line[0]], ["resume", true, false]);
  await rooms.setStage(ROOM, { upnext_break: 8 }, "test", { maxSlots: 4, maxPrice: 0 });
  assert.equal((await L.player(VIEWER, ROOM)).station_break, true);
});

test("ux 11: a booker who cancels their own waiting booking isn't told it 'didn't start'", async () => {
  await noBreak();
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 3 * 60000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "waiting");
  await S.end(bk.slot.id, "cancelled", booker.username);                    // (/api/stage/slots/:id/end by its booker)
  await L.watch();
  assert.equal((await booking(bk.slot.id)).state, "cancelled");
  const box = await inbox(booker);
  assert.equal(box.length, 1, JSON.stringify(box));
  assert.match(box[0].title, /waits for the current title/);
});

test("ux 12: a waiting booking says when the title it waits for should end (lib_wait.ends_at) on the schedule, the pad's coming-up list and Your bookings", async () => {
  await noBreak();
  await L.playFor(admin, { room: ROOM, key: "500" });
  await goLive();
  const booker = await mkUser();
  const bk = await Q.bookFor(booker, { room: ROOM, key: "501", start_at: T + 20 * 60000 });
  T = bk.slot.start_at + 1000;
  await L.watch();
  const s = await session();
  const want = Math.round(Number(s.updated) + (s.duration - (s.position || 0)) * 1000);
  const sch = (await S.roomSchedule(ROOM, VIEWER, false)).upcoming.find((x) => x.lib_wait);
  assert.deepEqual(sch.lib_wait, { title: "Charade (1963)", ends_at: want });
  assert.equal((await S.mine(booker.userId)).slots.find((x) => x.id === bk.slot.id).lib_wait.ends_at, want);
  assert.equal((await S.roomStage(ROOM, VIEWER)).upcoming.find((x) => x.id === bk.slot.id).lib_wait.ends_at, want);
});

test("ux 13: a booking waiting behind another BOOKED stream is told it waits for that stream (not 'right after the title')", async () => {
  await noBreak();
  const b1 = await mkUser(), b2 = await mkUser();
  const k1 = await Q.bookFor(b1, { room: ROOM, key: "501", start_at: T + 3 * 60000 });
  T = k1.slot.start_at + 1000;
  await L.watch();
  assert.equal((await activeQ()).user_id, b1.userId);
  await goLive();
  const k2 = await Q.bookFor(b2, { room: ROOM, key: "502", start_at: k1.slot.start_at + 102 * 60000 });
  T = k2.slot.start_at + 1000;
  await runQuery("UPDATE media_sessions SET updated = ?", [T]);
  await L.watch();
  assert.equal((await booking(k2.slot.id)).state, "waiting");
  const box = JSON.stringify(await inbox(b2));
  assert.match(box, /A booked stream \(“Night of the Living Dead \(1968\)”\) is still on - yours starts when it ends/);
});

test("ux 6: lining up behind someone else's running queue answers how many of its titles are still to come (behind_left)", async () => {
  await noBreak();
  await Q.startFor(admin, { room: ROOM, keys: ["911", "912", "913"] });
  await goLive();
  const r = await Q.after(await mkUser(), { room: ROOM, key: "500" });
  assert.deepEqual([r.behind_queue, r.behind_left, r.behind], [true, 2, "The Show — S1E1 Pilot"]);
});
