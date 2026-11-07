// upnext2 review fixes (1.99alc): the station break / "+ Add to the queue" against the REAL media-control service (deploy/mediactl, a mocked
// Plex + a fake ffmpeg) - the test/upnext-break.test.js harness - one test per finding of the two reviews of 559c2d08 (function: F3 F9,
// safety: F1-F7 F9 F11-F13), each failing on that build:
//   S1  a Cut / a failed start / a lost title in the break cancels the titles behind it; the watcher hands over only after a title that ended
//   S2  a paid queue without the points for its first title is refused at the press (no 8-15 s takeover), at the hand-over too
//   S3  a play / queue its starter ends in its own break counts on the daily cap
//   S4  "Take my titles out" (POST /api/medialib/queue/after/cancel); who added them only to whoever may control them
//   S5  the pad's 📼 limit on a grow; a price that dropped still starts it, one that rose doesn't
//   S6  a seek / resume on a fresh slot keeps the titles behind it
//   S7  no poster key in `coming`;  F9  ⏹ / Cut bump the stage version;  S9  one look per pad at a time
//   S11 a break asks for a free encoder (admins too);  S12 a 409 for our own title keeps it;  S13 Play from Plex off during a break
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upnext2-fixes-test-"));
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
const plex = {
  async search() { return []; },
  async item(key) {
    if (plexFail.has(key)) { const err = new Error("Not in the Plex library"); err.status = 404; throw err; }
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
const afterRow = async () => (await getQuery("SELECT * FROM media_queues WHERE room_id = ? AND state = 'after' ORDER BY id DESC LIMIT 1", [ROOM]))[0] || null;
const activeQ = async () => (await getQuery("SELECT * FROM media_queues WHERE room_id = ? AND state = 'active' ORDER BY id DESC LIMIT 1", [ROOM]))[0] || null;
const lastQ = async (u) => (await getQuery("SELECT * FROM media_queues WHERE user_id = ? ORDER BY id DESC LIMIT 1", [u.userId]))[0] || null;
const inbox = async (u) => getQuery("SELECT title, body FROM inbox WHERE user_id = ? ORDER BY rowid", [u.userId]).catch(() => []);

// upnext3 (1.99ali, owner 2026-11-07 item 7: "Start them instead."): what S1 pinned is reversed for a Cut of ONE slot and a failed / lost start - the
// picks waiting behind it are other people's and start next; a cut of the whole pad / site, a cut + ban, a ban (the stage cleared on purpose) still cancel them
test("S1 (upnext3): a Cut of a single play in its break, then the break's own TIMER - what's lined up behind it starts next (its own break, the pad's stage); a cut of the whole pad clears it", async () => {
  const t0 = T;
  const a = await L.playFor(admin, { room: ROOM, key: "500" });                // in its 8 s break
  const adder = await mkUser("pleb", 0);
  await Q.after(adder, { room: ROOM, key: "501" });                          // free (price 0) - waits behind the title in its break
  assert.ok(await afterRow());
  await S.end(a.slot.id, "cut", owner.username);                             // the pad's owner Cuts that one slot
  T = t0 + 8000;
  await L.breakDue(ROOM);                                                    // the break's timer path (not watchOne)
  assert.equal(await afterRow(), null, "used up");
  const q = await activeQ();
  assert.ok(q && q.user_id === adder.userId, "the adder's queue takes the stage");
  assert.equal((await featured()).id, q.slot_id, "the pad's featured stage: its card");
  assert.equal((await inbox(adder)).length, 0);
  await clear();
  const t1 = T;
  const b = await L.playFor(admin, { room: ROOM, key: "500" });
  await Q.after(adder, { room: ROOM, key: "501" });
  await S.end(b.slot.id, "cut", owner.username, { scope: "pad" });           // every slot of the pad (admin cut all / Pepe's !stage cut / "cut all")
  T = t1 + 8000;
  await L.breakDue(ROOM);
  assert.equal(await session(), null, "the cut play is closed");
  assert.equal(await afterRow(), null);
  assert.equal((await lastQ(adder)).notice, "after_cancelled");
  assert.match(JSON.stringify(await inbox(adder)), /stage cleared/);
  await L.watch();
  assert.equal(await activeQ(), null, "nothing takes the pad's stage");
  assert.equal(running().length, 0);
  assert.equal(await featured(), null);
});

test("S1 (upnext3): the break's start fails (media-control can't open it) - what's lined up behind it takes the stage over (the swap: the feature carries), its play ends 'didn't start'", async () => {
  const t0 = T;
  const a = await L.playFor(admin, { room: ROOM, key: "500" });
  const adder = await mkUser("pleb", 0);
  await Q.after(adder, { room: ROOM, key: "501" });
  plexFail.add("500");
  T = t0 + 8000;
  await L.breakDue(ROOM);
  const q = await activeQ();
  assert.ok(q && q.user_id === adder.userId);
  const sa = await S.getSlot(a.slot.id);
  assert.deepEqual([sa.status, sa.end_reason], ["ended", "library_failed"]);
  assert.equal((await play(a.play_id)).end_reason, "didn't start");
  assert.equal((await featured()).id, q.slot_id, "the feature carried over");
});

test("S1 (upnext3): the watcher starts waiting titles on its own (the site restarted at the hand-over) after a title that ended by itself AND after a Cut of that slot - never after a cut of the whole pad or a cut + ban", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  const adder = await mkUser("pleb", 0);
  for (const scope of ["pad", "ban"]) {
    const a = await L.playFor(admin, { room: ROOM, key: "500" });
    await pub(keyOf(last()));
    await Q.after(adder, { room: ROOM, key: "501" });
    await S.end(a.slot.id, "cut", owner.username, { scope });
    await runQuery("DELETE FROM media_sessions WHERE room_id = ?", [ROOM]);
    await L.watch();
    assert.equal(await afterRow(), null, scope + ": cancelled");
    assert.equal(await activeQ(), null, scope + ": nothing started");
    await clear();
    await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  }
  // a Cut of that one slot, then the site restarted before its watcher closed the play (no hand-over)
  let a = await L.playFor(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  await Q.after(adder, { room: ROOM, key: "501" });
  last().finish(); await settle();
  await S.end(a.slot.id, "cut", owner.username);
  await runQuery("DELETE FROM media_sessions WHERE room_id = ?", [ROOM]);
  await L.watch();
  assert.equal(await afterRow(), null, "used up");
  assert.equal((await activeQ()).user_id, adder.userId, "it started after the Cut of that slot");
  await clear();
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  // the title ended by itself (library_done) and the site went down at the hand-over: they start now
  a = await L.playFor(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  await Q.after(adder, { room: ROOM, key: "501" });
  last().finish(); await settle();
  await S.end(a.slot.id, "library_done", "system");
  await runQuery("DELETE FROM media_sessions WHERE room_id = ?", [ROOM]);
  await L.watch();
  const q = await activeQ();
  assert.ok(q && q.user_id === adder.userId, "the adder's queue is on");
});

test("S2 (safety F2): a paid queue without the points for its first hour is refused at the press (402) - no slot, no card; with them it starts (after its break)", async () => {
  await conf.set({ library_price: 1000, library_daily_cap: 2 }, "test");
  const broke = await mkUser("pleb", 500);
  const pv = await Q.preview(broke, { room: ROOM, key: "911", scope: "season" });
  assert.equal(pv.first_charge, 1000);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(Q.startFor(broke, { room: ROOM, key: "911", scope: "season", estimate: pv.estimate }),
                         (e) => e.status === 402 && e.extra.code === "pat" && e.extra.need === 1000 && /takes 1,000 PAT/.test(e.message));
  }
  assert.equal(await featured(), null, "never the pad's stage");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE room_id = ? AND status != 'ended'", [ROOM]))[0].n, 0);
  assert.equal(await bal(broke), 500);
  const ok = await mkUser("pleb", 1000);
  const r = await Q.startFor(ok, { room: ROOM, key: "911", scope: "season", estimate: pv.estimate });
  assert.ok(r.ok && r.starts_at, "enough for the first hour: it starts");
});

test("S2: titles behind a single title whose owner has no points for them when it ends don't take the stage over (a notice) - the title before ends 'finished'", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  const a = await L.playFor(admin, { room: ROOM, key: "500" });
  const k = keyOf(last()), p0 = await pub(k);
  await conf.set({ library_price: 1000 }, "test");
  const payer = await mkUser("pleb", 0);
  await Q.after(payer, { room: ROOM, key: "501", estimate: 2000 });        // (nothing is taken until it starts)
  last().finish(); await settle(); await unpub(k, p0.cid);
  await L.watch();
  assert.equal(await afterRow(), null);
  assert.equal((await lastQ(payer)).notice, "after_cancelled");
  assert.match(JSON.stringify(await inbox(payer)), /takes 2,000 PAT/);
  assert.equal(await activeQ(), null);
  assert.equal((await S.getSlot(a.slot.id)).end_reason, "library_done");
  assert.equal(await featured(), null, "no card for a start that can't happen");
});

test("S3 (safety F3): a paid ▶ Play its starter stops (or replaces) in its own break counts on the daily cap - refunded once, never charged twice; the pad's owner's ⏹ doesn't count against them", async () => {
  await conf.set({ library_price: 1000, library_daily_cap: 3 }, "test");
  const u = await mkUser("pleb", 100000);
  await L.playFor(u, { room: ROOM, key: "501", price: 2000 });
  T += 3000; await L.stop(u, ROOM);
  await L.playFor(u, { room: ROOM, key: "501", price: 2000 });
  T += 3000; await L.playFor(u, { room: ROOM, key: "502", price: 2000, replace: true });   // their own ▶ Play this instead, in the break
  T += 3000; await L.stop(u, ROOM);
  assert.equal(await bal(u), 100000, "every hold came back, once");
  assert.equal(await L.paidToday(u.userId), 3);
  await assert.rejects(L.playFor(u, { room: ROOM, key: "501", price: 2000 }), (e) => e.status === 429 && e.extra.code === "cap", "the cap holds");
  const v = await mkUser("pleb", 100000);
  await L.playFor(v, { room: ROOM, key: "501", price: 2000 });
  await L.stop(owner, ROOM);
  assert.equal(await L.paidToday(v.userId), 0, "someone else's ⏹ in the break");
  assert.equal(await bal(v), 100000);
});

test("S3: a paid queue its starter stops in its first break counts on the cap too (nothing was charged); one that played counts once", async () => {
  await conf.set({ library_price: 1000, library_daily_cap: 2 }, "test");
  const u = await mkUser("pleb", 100000);
  const pv = await Q.preview(u, { room: ROOM, key: "911", scope: "season" });
  for (let i = 0; i < 2; i++) {
    await Q.startFor(u, { room: ROOM, key: "911", scope: "season", estimate: pv.estimate });
    T += 3000; await L.stop(u, ROOM);
  }
  assert.equal(await bal(u), 100000);
  assert.equal(await L.paidToday(u.userId), 2);
  await assert.rejects(Q.startFor(u, { room: ROOM, key: "911", scope: "season", estimate: pv.estimate }), (e) => e.status === 429 && e.extra.code === "cap");
});

test("S4 (safety F4): titles added behind a single title can be taken out before they start - by their owner (no notice) or the pad's owner (a notice); nobody else; only those who may see who added them", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await L.playFor(admin, { room: ROOM, key: "500" });
  await conf.set({ library_price: 1000 }, "test");
  const u = await mkUser("pleb", 100000);
  await Q.after(u, { room: ROOM, key: "501", estimate: 2000 });
  const pu = await L.player(u, ROOM);
  assert.deepEqual([pu.after.mine, pu.after.can_withdraw, pu.after.by], [true, true, u.username]);
  const pv = await L.player(VIEWER, ROOM);
  assert.deepEqual([pv.after.mine, pv.after.can_withdraw, "by" in pv.after], [false, false, false], "never who added them to anyone else");
  const po = await L.player(null, ROOM);
  assert.equal("by" in po.after, false, "signed out: no name");
  assert.equal((await L.player(owner, ROOM)).after.can_withdraw, true, "the pad's owner");
  const other = await mkUser();
  await assert.rejects(Q.withdrawAfter(other, ROOM), (e) => e.status === 403 && e.extra.code === "control_denied");
  const r = await Q.withdrawAfter(u, ROOM);
  assert.deepEqual([r.ok, r.withdrawn], [true, 1]);
  assert.equal(await afterRow(), null);
  assert.equal((await L.mine(u, ROOM)).on_pad.after, undefined);
  assert.equal(await bal(u), 100000);
  assert.equal((await inbox(u)).length, 0, "their own: no notice");
  await assert.rejects(Q.withdrawAfter(u, ROOM), (e) => e.status === 404 && e.extra.code === "nothing_after");
  await Q.after(u, { room: ROOM, key: "501", estimate: 2000 });
  await Q.withdrawAfter(owner, ROOM);
  assert.equal((await lastQ(u)).notice, "after_removed");
  assert.match(JSON.stringify(await inbox(u)), /were taken out/);
  // (upnext3: + the row's id - the 📼 player's ✕ next to each one)
  assert.match(fs.readFileSync(path.join(repo, "mediaqueue.js"), "utf8"), /app\.post\("\/api\/medialib\/queue\/after\/cancel", \.\.\.J\(async \(req\) => withdrawAfter\(me\(req\), \(req\.body \|\| \{\}\)\.room, \(req\.body \|\| \{\}\)\.id\)\)\);/);
});

test("S5 (function F3 / safety F5): growing titles behind a single title past the pad's 📼 limit is refused (queue_full); what was confirmed starts at the hand-over - at a price that dropped meanwhile too", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0, slot_max_min: 130 }, "test", { maxSlots: 4, maxPrice: 0, maxMinutes: 360 });
  await L.playFor(admin, { room: ROOM, key: "500" });
  const k = keyOf(last()), p0 = await pub(k);
  await conf.set({ library_price: 1000 }, "test");
  const payer = await mkUser("pleb", 100000);
  await Q.after(payer, { room: ROOM, key: "501", estimate: 2000 });
  await assert.rejects(Q.after(payer, { room: ROOM, key: "502", estimate: 1000 }), (e) => e.status === 409 && e.extra.code === "queue_full" && /110 minutes/.test(e.message));
  await conf.set({ library_price: 500 }, "test");                            // cheaper by the time it starts
  last().finish(); await settle(); await unpub(k, p0.cid);
  await L.watch();
  const q = await activeQ();
  assert.ok(q && q.user_id === payer.userId, "it starts");
  assert.equal(q.per_hour, 500, "at today's price");
});

test("S5: a price that ROSE between the add and the hand-over: it doesn't start (a notice says the new figure) - never more than they said yes to", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await L.playFor(admin, { room: ROOM, key: "500" });
  const k = keyOf(last()), p0 = await pub(k);
  await conf.set({ library_price: 1000 }, "test");
  const payer = await mkUser("pleb", 100000);
  await Q.after(payer, { room: ROOM, key: "501", estimate: 2000 });
  await conf.set({ library_price: 1500 }, "test");
  last().finish(); await settle(); await unpub(k, p0.cid);
  await L.watch();
  assert.equal(await activeQ(), null);
  assert.match(JSON.stringify(await inbox(payer)), /3,000 PAT now/);
  assert.equal(await bal(payer), 100000);
});

test("S6 (safety F6): a seek after media-control lost the single title moves it to a fresh slot - the titles behind it wait behind the new slot and start when it ends", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  const a = await L.playFor(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  const u = await mkUser("pleb", 0);
  await Q.after(u, { room: ROOM, key: "501" });
  mstreams.stop(L.stageName(ROOM));                                          // media-control restarted: it forgot the stream
  const r = await L.seek(admin, ROOM, 600);
  assert.equal(r.same_slot, false);
  const s = await session();
  assert.notEqual(s.slot_id, a.slot.id);
  assert.equal((await afterRow()).behind, s.slot_id, "behind the title's new slot");
  await L.watch();
  assert.ok(await afterRow(), "still waiting (it used to be cancelled: 'something else started on the stage')");
  const k = keyOf(last()), p = await pub(k);
  last().finish(); await settle(); await unpub(k, p.cid);
  await L.watch();
  const q = await activeQ();
  assert.ok(q && q.user_id === u.userId, "it took the stage over when the title ended");
});

test("S7 (safety F7): what's coming carries no poster key - the same text for every viewer; /api/stage reads no sign-in for it", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await Q.startFor(admin, { room: ROOM, key: "911", scope: "season" });
  await pub(keyOf(last()));
  S.stageBump(ROOM);
  const c = await S.comingOf(ROOM);
  assert.deepEqual(c.next, { title: "Second", kind: "episode", year: null, show: "The Show", season: 1, episode: 2 });
  assert.equal(typeof S.comingPoster, "undefined");
  const br = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  assert.doesNotMatch(br, /comingPoster/);
  assert.match(br, /coming = await MS\.comingOf\(R\.id\);/);
});

test("F9 (function review): ⏹ and a Cut of a 📼 slot tell its pages at once (the stage version moves) - the card / the UP NEXT strip go with it", async () => {
  await L.playFor(admin, { room: ROOM, key: "500" });
  const v1 = S.stageVer(ROOM);
  await L.stop(admin, ROOM);
  assert.ok(S.stageVer(ROOM) > v1, "⏹ in the break");
  const r = await L.playFor(admin, { room: ROOM, key: "500" });
  const v2 = S.stageVer(ROOM);
  await S.end(r.slot.id, "cut", owner.username);
  assert.ok(S.stageVer(ROOM) > v2, "a Cut");
  const o = S.stageVer(OTHER);
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30, room: OTHER });
  await S.end(b.slot.id, "test", "test");
  assert.equal(S.stageVer(OTHER), o, "an ordinary slot's end doesn't");
});

test("S9 (safety F9): after a wake every page asks at once - they share ONE look at what's coming and ONE at the stage's slots", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await L.playFor(admin, { room: ROOM, key: "500" });
  await pub(keyOf(last()));
  const orig = L.comingFor;
  let n = 0;
  L.comingFor = async (id) => { n++; await new Promise((r) => setTimeout(r, 30)); return orig(id); };
  try {
    S.stageBump(ROOM);
    const all = await Promise.all(Array.from({ length: 12 }, () => S.comingOf(ROOM)));
    assert.equal(n, 1, "one look");
    assert.ok(all[0] && all[0].ends_at && all.every((x) => JSON.stringify(x) === JSON.stringify(all[0])));
    await S.comingOf(ROOM);
    assert.equal(n, 1, "then cached");
    S.stageBump(ROOM);
    await S.comingOf(ROOM);
    assert.equal(n, 2, "a bump: a fresh look");
  } finally { L.comingFor = orig; }
  const cos = require(path.join(repo, "cosmetics"));
  const ns = cos.nameStyle;
  let looks = 0;
  Object.defineProperty(cos, "nameStyle", { configurable: true, enumerable: true, get() { looks++; return ns; } });
  try {
    S.clearCache();
    const fs12 = await Promise.all(Array.from({ length: 12 }, () => S.featuredOf(ROOM, VIEWER)));
    assert.equal(looks, 1, "one look at the slots");
    assert.ok(fs12.every((f) => f && f.live));
  } finally { Object.defineProperty(cos, "nameStyle", { configurable: true, enumerable: true, writable: true, value: ns }); }
});

test("S11 (safety F11): a library admin's free ▶ Play / queue that takes a break asks for a free encoder like everyone's", async () => {
  await conf.set({ library_price: 1000 }, "test");
  const u = await mkUser("pleb", 100000);
  await L.playFor(u, { room: ROOM, key: "501", price: 2000 });               // someone's paid play in its break holds one of the two
  await L.playFor(admin, { room: OTHER, key: "500" });                      // the admin's holds the other
  await assert.rejects(L.playFor(admin, { room: THIRD, key: "502" }), (e) => e.status === 429 && e.extra.code === "encoder_busy");
  await assert.rejects(Q.startFor(admin, { room: THIRD, key: "911", scope: "season" }), (e) => e.status === 429 && e.extra.code === "encoder_busy");
});

test("S12 (safety F12): the break's start finds its own title already on media-control (an earlier start got there: a restart while it was on its way) - kept, never ended / refunded", async () => {
  await conf.set({ library_price: 1000 }, "test");
  const u = await mkUser("pleb", 100000);
  const t0 = T;
  const a = await L.playFor(u, { room: ROOM, key: "501", price: 2000 });
  await L._q.must("PUT", `/streams/${encodeURIComponent(L.stageName(ROOM))}`, { rtmp: S.RTMP_PUBLIC, key: L._keys.get(ROOM), ratingKey: "501", offset: 0, quality: 720, title: "x" });
  assert.equal(running().length, 1);
  T = t0 + 8000;
  await L.breakDue(ROOM);
  const s = await session();
  assert.equal(s && s.state, "playing");
  assert.notEqual((await S.getSlot(a.slot.id)).status, "ended");
  assert.equal(running().length, 1, "one encoder");
  assert.equal((await play(a.play_id)).charge, "held");
  await pub(keyOf(last()));
  await L.watch();
  assert.equal((await play(a.play_id)).charge, "routed", "routed once - it got on the stage");
  assert.equal(await bal(u), 98000);
});

test("S13: Play from Plex switched off during a single play's break - it never starts and its held charge comes back", async () => {
  await conf.set({ library_price: 1000 }, "test");
  const u = await mkUser("pleb", 100000);
  const t0 = T;
  const a = await L.playFor(u, { room: ROOM, key: "501", price: 2000 });
  assert.equal(await bal(u), 98000);
  await conf.set({ library_enabled: false }, "test");
  try { T = t0 + 8000; await L.breakDue(ROOM); } finally { await conf.set({ library_enabled: true }, "test"); }
  assert.equal(running().length, 0);
  assert.equal(await session(), null);
  assert.equal(await bal(u), 100000);
  assert.equal((await S.getSlot(a.slot.id)).status, "ended");
});
