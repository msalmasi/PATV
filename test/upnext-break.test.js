// upnext2 (owner 2026-11-05: "when does the 'next up' card actually show? ... I think I saw it come up once very briefly. So maybe items are
// just loading too fast?"): the 📼 STATION BREAK, end to end against the REAL media-control service (deploy/mediactl, a mocked Plex + a fake
// ffmpeg), like test/plexreplace.test.js:
//   * every title change - a fresh ▶ Play, ▶ Play this instead, a queue's first title, a queue moving on by itself, ⏭ / ⏮, a booked start -
//     sets the "Coming up next" marker FIRST and holds the encoder for the pad's break (default 8 s): the card is the pad's featured stage
//     for the whole break, then the title starts (and the card hands over at its first frame)
//   * the pad's own setting (0 = off, 5, 8, 15) and the site's switch / default (/admin/media)
//   * races: ⏹ / ▶ Play this instead / ⏭ / ⏮ / a Cut during a break - the newest wins, never two encoders, never a title that starts after a
//     ⏹; a priced play is charged once (a ⏹ in its break refunds it; a priced replace is charged once); a queue's per-hour charge only when
//     its title really starts
//   * a server restart during a break (its timer and the raw key gone): the watcher still starts the title, with a fresh key
//   * a single play in its break holds its encoder (busyOf); the 📼 player / Pepe say it's starting
//   TZ=UTC node --test test/upnext-break.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upnext-break-test-"));
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
  for (const q of await getQuery("SELECT id FROM media_queues WHERE state IN ('active','starting')")) await runQuery("UPDATE media_queues SET state = 'ended' WHERE id = ?", [q.id]);
  await runQuery("DELETE FROM media_sessions");
  mstreams.stopAll();
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  L._keys.clear();
  await S.setConfig({ takeover_mode: "when_idle", pepe_feature: null, pepe_feature_pads: {} }, "test");
  await conf.set({ library_price: 0, library_break: true, library_break_sec: 8 }, "test");
  for (const r of [ROOM, OTHER]) await rooms.setStage(r, { upnext_break: "" }, "test", { maxSlots: 4, maxPrice: 0 });
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
  for (const [r, t] of [[ROOM, "Break Pad"], [OTHER, "Other Pad"]]) await rooms.addRoom(r, t, "test");
  await runQuery("UPDATE rooms_registry SET owner_kind = 'user', owner_user_id = ? WHERE room_id = ?", [owner.userId, ROOM]);
  await rooms.loadCache();
  for (const r of [ROOM, OTHER]) await rooms.setStage(r, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await conf.set({ library_enabled: true, library_plex: true, library_price: 0, library_daily_cap: 50, library_free_daily_cap: 50, library_queue_announce_min: 20 }, "test");
  golive.nowPlaying = async () => ({ announced: true });
});
test.afterEach(clear);
test.after(() => { mstreams.stopAll(); server.close(); });

test("the defaults: the station break is ON, 8 s, everywhere (a pad's own setting: null = the site's)", async () => {
  assert.equal(conf.DEFAULTS.library_break, true);
  assert.equal(conf.DEFAULTS.library_break_sec, 8);
  assert.equal(await L.breakSec(ROOM), 8);
  assert.equal((await rooms.get(ROOM)).upnext_break, null);
  for (const [v, want] of [[0, 0], [5, 5], ["15", 15], [8, 8], [7, 8], ["", null], ["site", null]]) {
    const R = await rooms.setStage(ROOM, { upnext_break: v }, "test", { maxSlots: 4, maxPrice: 0 });
    assert.equal(R.upnext_break, want, "upnext_break " + JSON.stringify(v));
  }
  await rooms.setStage(ROOM, { upnext_break: 15 }, "test", { maxSlots: 4, maxPrice: 0 });
  assert.equal(await L.breakSec(ROOM), 15, "the pad's own");
  await conf.set({ library_break: false }, "test");
  assert.equal(await L.breakSec(ROOM), 0, "the site's switch off = no break anywhere");
  await conf.set({ library_break: true, library_break_sec: 5 }, "test");
  await rooms.setStage(ROOM, { upnext_break: "" }, "test", { maxSlots: 4, maxPrice: 0 });
  assert.equal(await L.breakSec(ROOM), 5, "the site's default");
  assert.equal((await conf.set({ library_break_sec: 9 }, "test")).settings.library_break_sec, 8, "only 0 / 5 / 8 / 15");
  const ev = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'stage' ORDER BY ts DESC, rowid DESC LIMIT 1", [ROOM]);
  assert.match(ev[0].detail, / break=site$/);
});

test("CASE fresh ▶ Play: the card is the featured stage for the whole 8 s break - no encoder until it's over - then the title starts and the card hands over at its first frame", async () => {
  const t0 = T;
  const r = await L.playFor(admin, { room: ROOM, key: "500" });
  assert.equal(r.ok, true);
  assert.equal(r.starts_at, t0 + 8000, "the answer says when it starts");
  assert.equal(r.break_sec, 8);
  assert.equal(procs.length, 0, "no ffmpeg during the break");
  assert.equal(onEncoder(), null, "media-control has nothing for the pad yet");
  const s = await session();
  assert.deepEqual([s.state, s.brk_until, s.position], ["break", t0 + 8000, 0]);
  // the card, all through the break (a 10 s poll lands in it; the old window was ~0.6 s)
  for (const at of [0, 3000, 7900]) {
    T = t0 + at;
    const f = await featured();
    assert.deepEqual([f.id, f.live, f.next && f.next.title, f.next && f.next.at], [r.slot.id, false, "Charade", t0], "card at +" + at + " ms");
  }
  const pl = await L.player(VIEWER, ROOM);
  assert.deepEqual([pl.on, pl.state, pl.starts_at, pl.title], [true, "waiting", t0 + 8000, "Charade (1963)"], "the 📼 player: starting");
  assert.equal((await L.padState(admin, ROOM)).library.title, "Charade (1963)");
  // the watcher before the end of the break changes nothing
  await L.watch();
  assert.equal(procs.length, 0);
  // it's over: the encoder starts (the timer, else the watcher) with the title, where it was asked to start
  T = t0 + 8000;
  await L.watch();
  assert.equal(procs.length, 1, "ONE ffmpeg");
  assert.equal(onEncoder().ratingKey, "500");
  assert.equal((await session()).state, "playing");
  assert.equal((await session()).brk_until, null);
  // still the card until the first frame...
  const f1 = await featured();
  assert.equal(f1.next.title, "Charade");
  // ...which hands over
  assert.equal((await pub(keyOf(last()))).status, 302);
  const f2 = await featured();
  assert.deepEqual([f2.id, f2.live, f2.next], [r.slot.id, true, undefined]);
  await L.watch();
  assert.equal(onEncoder().ratingKey, "500", "the watcher leaves it playing");
  assert.equal(procs.length, 1);
});

test("the pad's own setting: 0 = the old instant start; 15 = a 15 s break; the site's switch off = instant everywhere", async () => {
  await rooms.setStage(ROOM, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  const a = await L.playFor(admin, { room: ROOM, key: "500" });
  assert.equal(a.starts_at, undefined);
  assert.equal(procs.length, 1, "started at once");
  assert.equal((await session()).state, "playing");
  await clear();
  await rooms.setStage(ROOM, { upnext_break: 15 }, "test", { maxSlots: 4, maxPrice: 0 });
  const t0 = T;
  const b = await L.playFor(admin, { room: ROOM, key: "500" });
  assert.equal(b.starts_at, t0 + 15000);
  T = t0 + 14000; await L.watch(); assert.equal(procs.length, 0);
  T = t0 + 15000; await L.watch(); assert.equal(procs.length, 1);
  await clear();
  await conf.set({ library_break: false }, "test");
  await rooms.setStage(ROOM, { upnext_break: 15 }, "test", { maxSlots: 4, maxPrice: 0 });
  const c = await L.playFor(admin, { room: ROOM, key: "500" });
  assert.equal(c.starts_at, undefined, "the site's switch beats a pad's setting");
  assert.equal(procs.length, 1);
});

test("⏹ during a break: the slot ends, nothing ever starts, a held charge comes back ONCE (never routed: it never got on the stage)", async () => {
  await conf.set({ library_price: 1000 }, "test");
  const payer = await mkUser("pleb", 100000);
  const t0 = T;
  const r = await L.playFor(payer, { room: ROOM, key: "501", price: 2000 });
  assert.equal(await bal(payer), 98000, "held at the press");
  assert.equal((await play(r.play_id)).charge, "held");
  T = t0 + 3000;
  assert.deepEqual(await L.stop(payer, ROOM), { ok: true });
  assert.equal(await session(), null);
  const sl = await S.getSlot(r.slot.id);
  assert.deepEqual([sl.status, sl.end_reason], ["ended", "library_stopped"]);
  assert.equal(await bal(payer), 100000, "refunded");
  assert.equal((await play(r.play_id)).charge, "refunded");
  T = t0 + 8000;
  await L.watch();
  await L.breakDue(ROOM);
  assert.equal(procs.length, 0, "never a title that starts after a ⏹");
  assert.equal(await bal(payer), 100000, "refunded once");
  assert.equal(await featured(), null, "nothing featured any more");
});

test("▶ Play this instead during a break: the newest wins - the first title never starts, the new one takes its own break; a priced replace is charged ONCE", async () => {
  await conf.set({ library_price: 1000 }, "test");
  const payer = await mkUser("pleb", 100000);
  const t0 = T;
  const a = await L.playFor(payer, { room: ROOM, key: "501", price: 2000 });
  assert.equal(await bal(payer), 98000);
  T = t0 + 4000;
  const b = await L.playFor(payer, { room: ROOM, key: "502", replace: a.slot.id, price: 2000 });
  assert.equal(b.ok, true);
  assert.equal(b.replaced.title, "Night of the Living Dead (1968)");
  assert.equal(b.starts_at, t0 + 4000 + 8000, "its own break");
  assert.equal(await bal(payer), 98000 - 2000 + 2000, "the first play's hold came back, the replace is held once");
  assert.equal((await play(a.play_id)).charge, "refunded");
  assert.equal((await play(a.play_id)).end_reason, "replaced by " + payer.username);
  assert.equal((await play(b.play_id)).charge, "held");
  const f = await featured();
  assert.deepEqual([f.id, f.live, f.next.title], [b.slot.id, false, "Carnival of Souls"], "the card names the new title");
  // the first one's moment comes: nothing starts
  T = t0 + 8000;
  await L.watch();
  assert.equal(procs.length, 0);
  // the new one's
  T = t0 + 12000;
  await L.watch();
  assert.equal(procs.length, 1, "one encoder");
  assert.equal(onEncoder().ratingKey, "502");
  await pub(keyOf(last()));
  await L.watch();
  assert.equal((await play(b.play_id)).charge, "routed", "on the stage: routed");
  assert.equal(await bal(payer), 98000, "2000 in all");
});

test("▶ Play this instead over a title that PLAYS: the old encoder stops at once (the card replaces it), the new one starts after the break - never two encoders", async () => {
  await rooms.setStage(ROOM, { upnext_break: 5 }, "test", { maxSlots: 4, maxPrice: 0 });
  const a = await L.playFor(admin, { room: ROOM, key: "500" });
  T += 5000; await L.watch();
  await pub(keyOf(last()));
  const old = last();
  const t0 = T;
  const b = await L.playFor(admin, { room: ROOM, key: "501", replace: true });
  await settle();
  assert.ok(old.dead, "the old title is off - the card is on");
  assert.equal(onEncoder(), null);
  const f = await featured();
  assert.deepEqual([f.id, f.live, f.next.title, f.by], [b.slot.id, false, "Night of the Living Dead", "auto"], "the feature carried, the card for the new title");
  T = t0 + 5000;
  await L.watch();
  assert.equal(running().length, 1);
  assert.equal(onEncoder().ratingKey, "501");
  assert.equal((await S.getSlot(a.slot.id)).end_reason, "library_replaced");
});

test("a seek during a break moves where it starts; pause has nothing to pause; resume is a no-op", async () => {
  const t0 = T;
  await L.playFor(admin, { room: ROOM, key: "500" });
  await assert.rejects(L.pause(admin, ROOM), (e) => e.extra && e.extra.code === "not_playing");
  const r = await L.seek(admin, ROOM, 600);
  assert.deepEqual([r.ok, r.position, r.starts_at], [true, 600, t0 + 8000]);
  assert.equal((await session()).state, "break");
  assert.equal((await L.resume(admin, ROOM)).position, 600);
  T = t0 + 8000;
  await L.watch();
  assert.equal(onEncoder().ratingKey, "500");
  assert.ok(Math.abs(Number(onEncoder().offset) - 600) < 1, "starts where the seek put it: " + onEncoder().offset);
});

test("a server restart during a single play's break: the timer and the raw key are gone - the watcher still starts it, with a fresh key that publishes", async () => {
  const t0 = T;
  const r = await L.playFor(admin, { room: ROOM, key: "501" });
  L._keys.clear();                                    // (the process restarted: memory only)
  T = t0 + 9000;
  await L.watch();
  assert.equal(procs.length, 1);
  assert.equal((await pub(keyOf(last()))).status, 302, "the fresh key works");
  assert.equal((await featured()).live, true);
  assert.equal((await S.getSlot(r.slot.id)).status, "active");
});

test("a Cut during a break: the slot ends - the watcher closes the play, nothing starts", async () => {
  const t0 = T;
  const r = await L.playFor(admin, { room: ROOM, key: "500" });
  await S.end(r.slot.id, "cut", owner.username);
  T = t0 + 8000;
  await L.watch();
  assert.equal(procs.length, 0);
  assert.equal(await session(), null);
  assert.match((await play(r.play_id)).end_reason, /^slot /);
});

test("a single play in its break holds its encoder: with two encoders, a play elsewhere AND this break use them both - a third is refused", async () => {
  const payer = await mkUser("pleb", 100000);
  await conf.set({ library_price: 1000 }, "test");
  await L.playFor(admin, { room: ROOM, key: "500" });                      // in its break (no stream on media-control)
  await rooms.setStage(OTHER, { upnext_break: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await L.playFor(admin, { room: OTHER, key: "502" });                     // a stream on the other encoder
  const third = "Break.Third";
  await rooms.addRoom(third, "Third Pad", "test"); await rooms.loadCache();
  await assert.rejects(L.playFor(payer, { room: third, key: "501", price: 2000 }), (e) => e.status === 429 && e.extra.code === "encoder_busy");
  assert.equal(await bal(payer), 100000, "nothing taken");
});

test("CASE a 📼 queue: its first title takes the break (no per-hour charge until it starts), a title that ends by itself -> the break -> the next one; the card all through each break", async () => {
  await conf.set({ library_price: 1000 }, "test");
  const payer = await mkUser("pleb", 100000);
  const pv = await Q.preview(payer, { room: ROOM, key: "911", scope: "season" });
  const t0 = T;
  const r = await Q.startFor(payer, { room: ROOM, key: "911", scope: "season", estimate: pv.estimate });
  assert.equal(r.ok, true);
  assert.equal(r.starts_at, t0 + 8000);
  assert.equal(r.price, 0, "nothing charged during the break");
  assert.equal(await bal(payer), 100000);
  assert.equal(procs.length, 0);
  assert.equal(await session(), null, "no session in a queue's break");
  const f = await featured();
  assert.deepEqual([f.id, f.live, f.next.show, f.next.episode], [r.slot.id, false, "The Show", 1]);
  const v = (await Q.views({ userId: payer.userId }))[0];
  assert.deepEqual([v.state, v.waiting, v.starts_at, v.pos], ["active", true, t0 + 8000, 0]);
  assert.equal((await L.player(VIEWER, ROOM)).starts_at, t0 + 8000);
  // the watcher (a lost timer) before its time: nothing
  T = t0 + 7000; await L.watch(); assert.equal(procs.length, 0);
  T = t0 + 8000; await L.watch();
  assert.equal(procs.length, 1);
  assert.equal(onEncoder().ratingKey, "911");
  assert.equal(await bal(payer), 99000, "the first started hour, taken as it starts");
  const k = keyOf(last());
  const p1 = await pub(k);
  assert.equal(p1.status, 302);
  // title 1 ends by itself
  last().finish();
  await settle();
  await unpub(k, p1.cid);
  const t1 = T;
  await L.watch();
  const s2 = await getQuery("SELECT * FROM media_queues WHERE id = ?", [r.queue_id]);
  assert.equal(JSON.parse(s2[0].brk).pos, 1, "title 2 is in its break");
  assert.equal(procs.length, 1, "no new encoder yet");
  const g = await featured();
  assert.deepEqual([g.live, g.next && g.next.episode], [false, 2], "the card for episode 2");
  T = t1 + 8000; await L.watch();
  assert.equal(procs.length, 2);
  assert.equal(onEncoder().ratingKey, "912");
  assert.equal((await getQuery("SELECT brk FROM media_queues WHERE id = ?", [r.queue_id]))[0].brk, null);
});

test("CASE ⏭ / ⏮ during a queue's break: the newest wins - the skipped title never starts, the next one takes its own break; ⏹ in a break ends the queue and nothing starts", async () => {
  await rooms.setStage(ROOM, { upnext_break: 5 }, "test", { maxSlots: 4, maxPrice: 0 });
  const t0 = T;
  const r = await Q.startFor(admin, { room: ROOM, key: "911", scope: "season" });
  T = t0 + 5000; await L.watch();
  assert.equal(onEncoder().ratingKey, "911");
  const k1 = keyOf(last()), p1 = await pub(k1);
  // ⏭: the encoder stops now, episode 2 in its break
  const t1 = T;
  const sk = await Q.next(admin, ROOM);
  await settle();
  await unpub(k1, p1.cid);                            // (nginx's publish_done for the encoder ⏭ stopped)
  assert.equal(sk.break, true);
  assert.equal(sk.pos, 1);
  assert.equal(running().length, 0, "the old title is off");
  assert.deepEqual([(await featured()).live, (await featured()).next.episode], [false, 2], "the card for episode 2");
  // ⏭ again inside the break: episode 3's break instead
  T = t1 + 2000;
  const sk2 = await Q.next(admin, ROOM);
  assert.deepEqual([sk2.break, sk2.pos, sk2.starts_at], [true, 2, t1 + 2000 + 5000]);
  assert.equal((await featured()).next.episode, 3);
  T = t1 + 5000; await L.watch();
  assert.equal(running().length, 0, "episode 2's moment came: nothing (it was skipped)");
  T = t1 + 7000; await L.watch();
  assert.equal(running().length, 1);
  assert.equal(onEncoder().ratingKey, "913", "only the newest");
  // ⏮ then ⏹ inside that break
  await pub(keyOf(last()));
  const t2 = T;
  const bk = await Q.prev(admin, ROOM);
  assert.deepEqual([bk.break, bk.pos], [true, 1]);
  await settle();
  await L.stop(admin, ROOM);
  T = t2 + 6000; await L.watch(); await L.breakDue(ROOM);
  assert.equal(running().length, 0, "⏹ won: nothing starts after it");
  assert.equal((await getQuery("SELECT state FROM media_queues WHERE id = ?", [r.queue_id]))[0].state, "ended");
});

test("▶ Play this instead during a QUEUE's break: the queue ends 'replaced', its title never starts, the new title takes its own break", async () => {
  await rooms.setStage(ROOM, { upnext_break: 5 }, "test", { maxSlots: 4, maxPrice: 0 });
  const t0 = T;
  const q = await Q.startFor(admin, { room: ROOM, key: "911", scope: "season" });
  T = t0 + 1000;
  const r = await L.playFor(admin, { room: ROOM, key: "500", replace: q.slot.id });
  assert.equal(r.replaced.queue, true);
  assert.equal(r.starts_at, T + 5000);
  T = t0 + 5000; await L.watch();
  assert.equal(running().length, 0, "the queue's title never starts");
  T = t0 + 6000; await L.watch();
  assert.equal(running().length, 1);
  assert.equal(onEncoder().ratingKey, "500");
  assert.match((await getQuery("SELECT end_reason FROM media_queues WHERE id = ?", [q.queue_id]))[0].end_reason, /^replaced by /);
});

test("a server restart during a queue's break: the watcher starts the title when it's due, with a fresh key", async () => {
  const t0 = T;
  const q = await Q.startFor(admin, { room: ROOM, key: "911", scope: "season" });
  L._keys.clear();
  T = t0 + 8000;
  await L.watch();
  assert.equal(running().length, 1);
  assert.equal((await pub(keyOf(last()))).status, 302);
  assert.equal((await S.getSlot(q.slot.id)).status, "active");
});

test("CASE a booked start (the owner's \"4 minutes later\"): at its time the card comes up and the title starts after the break", async () => {
  const t0 = T;
  const bk = await Q.bookFor(admin, { room: ROOM, key: "501", start_at: t0 + 4 * 60000 });
  assert.equal(bk.ok, true);
  T = t0 + 4 * 60000;
  await L.watch();                                    // (watchIdle -> watchBookings: the booking starts - its break)
  assert.equal(procs.length, 0);
  const f = await featured();
  assert.deepEqual([f.id, f.live, f.next && f.next.title], [bk.slot.id, false, "Night of the Living Dead"]);
  T += 8000;
  await L.watch();
  assert.equal(procs.length, 1);
  assert.equal(onEncoder().ratingKey, "501");
});

test("the settings: the pad's stage form has the 📼 station break (its own or the site's - en.json strings) and /admin/media the site's switch + default", () => {
  const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
  const EN = JSON.parse(read("locales", "en.json"));
  const ps = read("views", "padSettings.ejs");
  assert.match(ps, /<select name="upnext_break">/);
  assert.match(ps, /\[0, 5, 8, 15\]\.forEach/);
  for (const k of ["label", "site", "off", "sec", "hint", "site_off"]) {
    assert.ok(EN["pad.settings.upnext_break." + k], "en.json pad.settings.upnext_break." + k);
    assert.ok(ps.includes("t('pad.settings.upnext_break." + k + "'"), "the form uses " + k);
  }
  const ma = read("views", "mediaAdmin.ejs");
  assert.match(ma, /name="_bools" value="[^"]*\blibrary_break\b/, "an unticked switch saves as off");
  assert.match(ma, /<input type="checkbox" name="library_break"/);
  assert.match(ma, /<select name="library_break_sec">/);
  assert.match(read("padsettings.js"), /libBreak:/);
});
