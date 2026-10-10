// Offline tests for 📼 Play from library (medialib.js + mainstage library slots), end to end against the REAL
// media-control service (deploy/mediactl) running locally with a mocked Plex and a fake ffmpeg:
// signed calls, admin-only + flag + keys, a free library slot whose key nginx-rtmp's publish gate accepts, one per pad,
// pause / resume / seek / stop, the watcher ending the slot when the stream ends and stopping the stream when the
// slot is cut, the long pause allowance, the play log - and the TLS pin.
//   node --test test/medialib.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "medialib-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SECRET = "k".repeat(48);
process.env.MEDIACTL_SECRET = SECRET;
delete process.env.MEDIACTL_TLS_SHA256;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const conf = require(path.join(repo, "mediaconf"));
const L = require(path.join(repo, "medialib"));
const M = require(path.join(repo, "deploy", "mediactl", "mediactl.js"));

// ── the media-control service, real, with a fake Plex + ffmpeg ──
const media = path.join(tmp, "media");
fs.mkdirSync(media, { recursive: true });
const FILE = path.join(media, "Charade (1963).mkv");
fs.writeFileSync(FILE, "x");
const plex = {
  async search() { return [{ key: "500", type: "movie", title: "Charade", year: 1963, duration: 6780, poster: true }]; },
  async item(key) {
    if (key === "500") return { key, type: "movie", title: "Charade", year: 1963, file: FILE, duration: 6780, width: 1920, height: 1080, hdr: false,
                                audio: [{ index: 1, label: "English", default: true }], subs: [{ index: 2, rel: 0, label: "English", codec: "srt", burnable: true, image: false }] };
    if (key === "600") return { key, type: "show", title: "A Show", episodes: [] };
    const e = new Error("Not in the Plex library"); e.status = 404; throw e;
  },
  async poster() { return { type: "image/jpeg", body: Buffer.from([1, 2, 3]) }; },
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
const mstreams = M.makeStreams(mcfg, plex, fakeSpawn, undefined, async () => null);     // no ffprobe here
const { server } = M.makeServer(mcfg, { plex, streams: mstreams });

let n = 0;
async function mkUser(cls = "pleb") {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, 0)", [id, "user" + n, "User " + n, cls]);
  return { userId: id, username: "user" + n, class: cls };
}
let admin, staff, pleb;
const ROOM = "PepeFrog.Room";
const pub = (name) => S.rtmpCallback({ call: "publish", app: "stage", name, addr: "1.2.3.4", clientid: "9" });
const tick = () => new Promise((r) => setImmediate(r));

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.MEDIACTL_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ max_concurrent: 4, idle_grace_min: 5, enabled: true }, "test");
  await L.init();
  admin = await mkUser("Admin"); staff = await mkUser("Staff"); pleb = await mkUser();
});
test.after(() => { mstreams.stopAll(); server.close(); });

test("off by default: the flag is off, and only admins may use it", async () => {
  assert.equal(conf.on.library(), false);
  await assert.rejects(L.search(admin, "charade"), /switched off/);
  await conf.set({ library_enabled: true }, "test");
  assert.equal(conf.on.library(), true);
  await assert.rejects(L.search(pleb, "charade"), (e) => e.status === 403);
  await assert.rejects(L.search(staff, "charade"), (e) => e.status === 403, "staff only when library_allow = staff");
  const r = await L.search(admin, "charade");
  assert.equal(r[0].key, "500");
  const keep = process.env.MEDIACTL_SECRET;
  delete process.env.MEDIACTL_SECRET;
  assert.equal(conf.on.library(), false, "no secret = off whatever the flag says");
  process.env.MEDIACTL_SECRET = keep;
});

test("a wrong shared secret is a clear error, nothing is opened", async () => {
  process.env.MEDIACTL_SECRET = "x".repeat(48);
  await assert.rejects(L.search(admin, "charade"), /refused our signature/);
  process.env.MEDIACTL_SECRET = SECRET;
});

test("play: a free 📼 library slot, the encoder pushes with ITS key (the publish gate takes it), one per pad, logged", async () => {
  procs.length = 0;
  await assert.rejects(L.play(admin, { room: ROOM, key: "600" }), /movie or an episode/);
  const r = await L.play(admin, { room: ROOM, key: "500", quality: 1080, offset: 60, sub: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.title, "Charade (1963)");
  const slot = await S.getSlot(r.slot.id);
  assert.equal(slot.source, "library");
  assert.equal(slot.held, 0);
  assert.equal(slot.price_per_min, 0);
  assert.equal(slot.title, "📼 Charade (1963)");
  assert.ok(slot.max_minutes >= Math.ceil((6780 - 60) / 60), "long enough for the rest of the film");
  // the encoder's RTMP url ends with the slot's one-time key, which nginx-rtmp's on_publish accepts
  assert.equal(procs.length, 1);
  const url = procs[0].args[procs[0].args.length - 1];
  assert.ok(url.startsWith(S.RTMP_PUBLIC + "/"));
  const key = url.slice(S.RTMP_PUBLIC.length + 1);
  const gate = await pub(key);
  assert.equal(gate.status, 302);
  assert.ok(procs[0].args.join(" ").includes("-ss 60.000"));
  assert.ok(procs[0].args.join(" ").includes("subtitles="));
  await assert.rejects(L.play(admin, { room: ROOM, key: "500" }), (e) => e.status === 409, "one per pad");
  const log = await getQuery("SELECT * FROM media_plays");
  assert.equal(log.length, 1);
  assert.equal(log[0].username, admin.username);
  assert.equal(log[0].room_id, ROOM);
  assert.equal(log[0].title, "Charade (1963)");
  assert.equal(log[0].offset_start, 60);
  const st = await L.state(admin);
  assert.equal(st.sessions.length, 1);
  assert.equal(st.sessions[0].state, "playing");
  assert.equal(S.view(slot).library, true);
});

test("pause stops the encoder and keeps the slot (longer idle allowance); resume restarts at the same place", async () => {
  procs[procs.length - 1].stdout.write("out_time_us=120000000\n");
  await tick();
  const p = await L.pause(admin, ROOM);
  assert.equal(p.ok, true);
  assert.equal(p.position, 180);
  const s = (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [ROOM]))[0];
  assert.equal(s.state, "paused");
  const slot = await S.getSlot(s.slot_id);
  assert.equal(S.idleMinFor(slot), 30, "library slots may idle (pause) for library_pause_max_min");
  assert.equal(S.idleMinFor({ source: null }), 5);
  const before = procs.length;
  const r = await L.resume(admin, ROOM);
  assert.equal(r.same_slot, true);
  assert.equal(procs.length, before + 1);
  assert.ok(procs[procs.length - 1].args.join(" ").includes("-ss 180.000"));
});

test("seek restarts at the new time on the same slot and stretches the slot if needed", async () => {
  const s0 = (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [ROOM]))[0];
  await runQuery("UPDATE stage_slots SET max_minutes = 10, live_ms = 300000 WHERE id = ?", [s0.slot_id]);
  const r = await L.seek(admin, ROOM, 100);
  assert.equal(r.same_slot, true);
  assert.ok(procs[procs.length - 1].args.join(" ").includes("-ss 100.000"));
  const slot = await S.getSlot(s0.slot_id);
  assert.ok(slot.max_minutes >= 5 + Math.ceil((6780 - 100) / 60), "stretched");
});

test("the watcher: the stream finishing ends the slot; Cut on the stage stops the stream", async () => {
  const s0 = (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [ROOM]))[0];
  const p = procs[procs.length - 1];
  p.stdout.write("out_time_us=6680000000\n");
  await tick();
  p.emit("exit", 0);
  await L.watch();
  assert.equal((await getQuery("SELECT * FROM media_sessions")).length, 0);
  const slot = await S.getSlot(s0.slot_id);
  assert.equal(slot.status, "ended");
  assert.equal(slot.end_reason, "library_done");
  assert.equal((await getQuery("SELECT end_reason FROM media_plays WHERE id = ?", [s0.play_id]))[0].end_reason, "finished");
  // play again, then the stage cuts it
  const r = await L.play(admin, { room: ROOM, key: "500" });
  const enc = procs[procs.length - 1];
  await S.end(r.slot.id, "cut", "somebody");
  await L.watch();
  assert.equal(enc.dead, true, "the encoder was stopped");
  assert.equal((await getQuery("SELECT * FROM media_sessions")).length, 0);
  assert.equal(mstreams.list().length, 0);
});

test("stop: ends the slot and the encoder; resume after the slot ended (long pause) opens a fresh slot", async () => {
  const r = await L.play(admin, { room: ROOM, key: "500" });
  await L.pause(admin, ROOM);
  await S.end(r.slot.id, "idle", "system");                 // paused past the allowance
  const again = await L.resume(admin, ROOM);
  assert.equal(again.same_slot, false);
  assert.notEqual(again.slot.id, r.slot.id);
  const st = await L.stop(admin, ROOM);
  assert.equal(st.ok, true);
  assert.equal((await S.getSlot(again.slot.id)).status, "ended");
  assert.equal(mstreams.list().length, 0);
  await assert.rejects(L.stop(admin, ROOM), (e) => e.status === 404);
});

test("the encoder failing to start ends the slot it opened", async () => {
  const before = (await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE status != 'ended'"))[0].n;
  mcfg.maxStreams = 0;                                         // mediactl refuses (429)
  try { await assert.rejects(L.play(admin, { room: ROOM, key: "500" }), (e) => e.status === 429); }
  finally { mcfg.maxStreams = 2; }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE status != 'ended'"))[0].n, before);
  assert.equal((await getQuery("SELECT * FROM media_sessions")).length, 0);
});

test("staging prefixes its mediactl stage names (one service serves both sites)", () => {
  assert.equal(L.stageName("PepeFrog.Room"), "PepeFrog.Room");
  assert.match(L.stageName("weird id/with spaces"), /^r-[0-9a-f]{16}$/);
});

// ── 1.99jn: Plex users play for PAT ──
const INV_MONTH = "1c120384-c080-4186-b246-f1227e82ab01", INV_LIFE = "e101bcff-cc8c-4db9-b4ca-302ef5e16871";
const DAY = 86400000;
let plexU, other;
async function order(userId, prizeId, ageDays, status = "completed") {
  require(path.join(repo, "shop"));                                          // shop's tables (created on load)
  for (let i = 0; i < 100 && !(await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'shop_order_events'")).length; i++) await new Promise((r) => setTimeout(r, 20));
  await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, official, title, price, status, created) VALUES (?, ?, 1, 'Plex Invite', 1000000, ?, ?)`,
                 [prizeId, userId, status, Date.now() - ageDays * DAY]);
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
async function pubLatest() {
  const url = procs[procs.length - 1].args[procs[procs.length - 1].args.length - 1];
  return pub(url.slice(S.RTMP_PUBLIC.length + 1));
}

// 1.99jp: plexU is an ordinary member who PAYS (not on our Plex server); Plex members play free (the next test)
test("1.99jp terms: everyone signed in may play - non-members pay per started hour, members on the server free, override list, admins free", async () => {
  await conf.set({ library_enabled: true, library_plex: true, library_price: 100000, library_daily_cap: 2 }, "test");
  plexU = await mkUser(); other = await mkUser();
  await runQuery("UPDATE users SET points_balance = 1000000 WHERE userId IN (?, ?)", [plexU.userId, other.userId]);
  let a = await L.access(other);
  assert.deepEqual([a.ok, a.free, a.how], [true, false, "paid"], "not locked any more: they pay");
  assert.equal(a.hint, "/shop/item/" + INV_MONTH, "the hint points at the store's Plex access");
  // a store purchase alone isn't membership any more - being on the server is (plexmembers.js)
  await order(plexU.userId, INV_MONTH, 10);
  assert.equal((await L.access(plexU)).how, "paid");
  const PM = require(path.join(repo, "plexmembers"));
  await PM.init();
  const mem = await mkUser();
  await runQuery("INSERT INTO plex_members (plex_id, username, on_server, pending, user_id, access) VALUES ('900', 'memp', 1, 0, ?, 'pre-existing')", [mem.userId]);
  a = await L.access(mem);
  assert.deepEqual([a.ok, a.free, a.how], [true, true, "plex"]);
  const pend = await mkUser();
  await runQuery("INSERT INTO plex_members (plex_id, username, on_server, pending, user_id, access) VALUES ('901', 'pendp', 1, 1, ?, 'pre-existing')", [pend.userId]);
  assert.equal((await L.access(pend)).how, "paid", "an invite not accepted yet isn't membership");
  await conf.set({ library_users: "Nobody, " + other.username.toUpperCase() }, "test");
  assert.equal((await L.access(other)).how, "override");
  assert.equal((await L.access(other)).free, true);
  await conf.set({ library_users: "" }, "test");
  // admins stay free; the switch off = everyone but the admins is out
  assert.equal((await L.access(admin)).free, true);
  await conf.set({ library_plex: false }, "test");
  assert.equal((await L.access(plexU)).why, "off");
  assert.equal((await L.access(mem)).why, "off");
  assert.equal((await L.access(admin)).ok, true);
  await conf.set({ library_plex: true }, "test");
  assert.equal((await L.search(plexU, "charade"))[0].key, "500");
  const it = await L.item(plexU, "500");
  assert.equal(it.file, undefined, "file paths are for admins");
  assert.deepEqual(it.pricing, { price: 200000, hours: 2, per_hour: 100000, free: false });
  assert.deepEqual((await L.item(mem, "500")).pricing, { price: 0, hours: 0, per_hour: 0, free: true });
  // a member's free play: no price, logged as 'plex', counted against the free cap
  await conf.set({ library_free_daily_cap: 1 }, "test");
  const r = await L.play(mem, { room: ROOM, key: "500" });
  assert.equal(r.price, 0);
  const p = (await getQuery("SELECT charge, access FROM media_plays WHERE id = ?", [r.play_id]))[0];
  assert.deepEqual([p.charge, p.access], ["free", "plex"]);
  assert.equal((await L.mine(mem)).daily_left, 0);
  await L.stop(mem, ROOM);
  await assert.rejects(L.play(mem, { room: ROOM, key: "500" }), (e) => e.status === 429 && /24 hours/.test(e.message));
  await conf.set({ library_free_daily_cap: 5 }, "test");
});

test("price: library_price per STARTED hour of what's left from the start point, at least one hour", () => {
  const S0 = { library_price: 100000 };
  assert.deepEqual(L.priceFor(6780, 0, S0), { price: 200000, hours: 2, per_hour: 100000 });     // 1:53 -> 2 h
  assert.equal(L.priceFor(6780, 3600, S0).price, 100000);                                       // 53 min left
  assert.equal(L.priceFor(2700, 0, S0).price, 100000);                                          // a 45-min episode
  assert.equal(L.priceFor(10900, 0, S0).price, 400000);                                         // 3:01:40 -> 4 h
  assert.equal(L.priceFor(null, 0, S0).price, 100000);
  assert.equal(L.priceFor(6780, 0, { library_price: 0 }).price, 0);
});

test("a paid play: confirm the price, PAT held on a completed order, ROUTED 50/50 Fort Knox / room vault once it's on the stage", async () => {
  procs.length = 0;
  await assert.rejects(L.play(plexU, { room: ROOM, key: "500" }), (e) => e.status === 400 && e.extra.price === 200000, "the price has to be confirmed");
  await assert.rejects(L.play(plexU, { room: ROOM, key: "500", price: 100000 }), (e) => e.status === 409 && e.extra.price === 200000);
  assert.equal(procs.length, 0);
  assert.equal(await bal(plexU), 1000000, "nothing charged yet");
  const r = await L.play(plexU, { room: ROOM, key: "500", price: 200000 });
  assert.equal(r.price, 200000);
  assert.equal(await bal(plexU), 800000);
  const o = (await getQuery("SELECT * FROM shop_orders WHERE id = ?", [r.order_id]))[0];
  assert.equal(o.status, "completed");
  assert.equal(o.seller_paid, 0, "held: nobody credited yet");
  assert.equal(o.source, "medialib");
  let p = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [r.play_id]))[0];
  assert.equal(p.charge, "held");
  assert.equal(p.price, 200000);
  assert.equal(p.access, "paid");
  await L.watch();
  assert.equal((await getQuery("SELECT charge FROM media_plays WHERE id = ?", [r.play_id]))[0].charge, "held", "not live yet: still held");
  // someone else can't touch it; its starter can
  await assert.rejects(L.pause(other, ROOM), (e) => e.status === 403);
  assert.equal((await pubLatest()).status, 302);                             // the encoder's publish: the slot goes live
  await L.watch();
  p = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [r.play_id]))[0];
  assert.equal(p.charge, "routed");
  const led = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = ?", ["library:" + r.play_id]))[0];
  assert.equal(led.kind, "library_play");
  assert.equal(led.amount, 200000);
  assert.equal(led.fortknox, 100000);
  assert.equal(led.room_vault, 100000);
  assert.equal(led.room_id, ROOM);
  const claim = (await getQuery("SELECT * FROM reserve_claims WHERE flow LIKE '%library_play' AND amount = -100000"));
  assert.ok(claim.length >= 1, "the Fort Knox half is a reserve claim");
  assert.equal((await getQuery("SELECT seller_paid FROM shop_orders WHERE id = ?", [r.order_id]))[0].seller_paid, 1);
  await L.watch();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger WHERE ref = ?", ["library:" + r.play_id]))[0].n, 1, "routed once");
  // its starter controls it from the Go-live page
  assert.equal((await L.pause(plexU, ROOM)).ok, true);
  const mine = await L.mine(plexU);
  assert.equal(mine.sessions.length, 1);
  assert.equal(mine.sessions[0].charge, "routed");
  assert.equal(mine.daily_left, 1);
  assert.equal(mine.streams.max, 2);
  const res = await L.resume(plexU, ROOM);
  assert.equal(res.same_slot, true);
  assert.equal(await bal(plexU), 800000, "resume / seek are free");
  assert.equal((await L.stop(plexU, ROOM)).ok, true);
  assert.equal(await bal(plexU), 800000, "it was on the stage: no refund");
});

test("refunds: the encoder refusing to start, and a play stopped before it ever reached the stage", async () => {
  mcfg.maxStreams = 0;                                                      // mediactl refuses the start (429)
  try { await assert.rejects(L.play(plexU, { room: ROOM, key: "500", price: 200000 }), (e) => e.status === 429 && /refunded/.test(e.message)); }
  finally { mcfg.maxStreams = 2; }
  assert.equal(await bal(plexU), 800000, "refunded at once");
  const last = (await getQuery("SELECT * FROM shop_orders WHERE buyer_id = ? ORDER BY id DESC LIMIT 1", [plexU.userId]))[0];
  assert.equal(last.status, "refunded");
  const r = await L.play(plexU, { room: ROOM, key: "500", price: 200000 });
  assert.equal(await bal(plexU), 600000);
  await L.stop(plexU, ROOM);                                                 // never published
  assert.equal(await bal(plexU), 800000, "never on the stage: refunded");
  assert.equal((await getQuery("SELECT charge FROM media_plays WHERE id = ?", [r.play_id]))[0].charge, "refunded");
  assert.equal((await getQuery("SELECT status FROM shop_orders WHERE id = ?", [r.order_id]))[0].status, "refunded");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger WHERE ref = ?", ["library:" + r.play_id]))[0].n, 0);
});

test("limits: every encoder busy = refused before paying; the daily cap; the pad's owner playing on their own pad = 100% Fort Knox", async () => {
  // both of mediactl's streams busy (an admin's on another pad + a fake)
  mcfg.maxStreams = 1;
  const a = await L.play(admin, { room: "other.Room", key: "500" }).catch((e) => e);
  try {
    if (a instanceof Error) {
      // other.Room isn't a pad here: occupy the encoder directly instead
      await mstreams.start("busy.Room", { rtmp: S.RTMP_PUBLIC, key: "psBUSYBUSYBUSY12", ratingKey: "500" });
    }
    const before = await bal(plexU);
    await assert.rejects(L.play(plexU, { room: ROOM, key: "500", price: 200000 }), (e) => e.status === 429 && /in use/.test(e.message));
    assert.equal(await bal(plexU), before, "nothing charged");
  } finally {
    mcfg.maxStreams = 2;
    mstreams.stop("busy.Room");
    if (!(a instanceof Error)) await L.stop(admin, "other.Room").catch(() => {});
  }
  // the owner's own pad: all of it to Fort Knox
  const rooms = require(path.join(repo, "rooms"));
  const orig = rooms.stageSettings;
  rooms.stageSettings = async (id) => ({ ...(await orig(id)), owner: { userId: plexU.userId, username: plexU.username } });
  try {
    const r = await L.play(plexU, { room: ROOM, key: "500", offset: 6780 - 600, price: 100000 });
    await pubLatest();
    await L.watch();
    const led = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = ?", ["library:" + r.play_id]))[0];
    assert.equal(led.fortknox, 100000);
    assert.equal(led.room_vault, 0);
    assert.equal(led.owner_self, 1);
    await L.stop(plexU, ROOM);
  } finally { rooms.stageSettings = orig; }
  // two paid plays in 24 h (refunded ones don't count): the cap
  await assert.rejects(L.play(plexU, { room: ROOM, key: "500", price: 200000 }), (e) => e.status === 429 && /24 hours/.test(e.message));
  assert.equal((await L.mine(plexU)).daily_left, 0);
  // admins are never capped or charged
  const ar = await L.play(admin, { room: ROOM, key: "500" });
  assert.equal(ar.price, 0);
  assert.equal((await getQuery("SELECT charge FROM media_plays WHERE id = ?", [ar.play_id]))[0].charge, "free");
  await L.stop(admin, ROOM);
});

test("a held charge carries over when a resume needs a fresh slot, and is settled by how the new one goes", async () => {
  await runQuery("DELETE FROM media_plays WHERE user_id = ?", [plexU.userId]);   // reset the daily cap
  const r = await L.play(plexU, { room: ROOM, key: "500", price: 200000 });
  const b0 = await bal(plexU);
  await L.pause(plexU, ROOM);
  await S.end(r.slot.id, "idle", "system");                                  // paused too long, before ever going live
  const again = await L.resume(plexU, ROOM);
  assert.equal(again.same_slot, false);
  assert.equal(again.price, 0, "no second charge");
  const p0 = (await getQuery("SELECT charge FROM media_plays WHERE id = ?", [r.play_id]))[0];
  assert.equal(p0.charge, "moved");
  const p1 = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [again.play_id]))[0];
  assert.equal(p1.charge, "held");
  assert.equal(p1.price, 200000);
  assert.equal(p1.order_id, r.order_id);
  assert.equal(p1.user_id, plexU.userId);
  await pubLatest();
  await L.watch();
  assert.equal((await getQuery("SELECT charge FROM media_plays WHERE id = ?", [again.play_id]))[0].charge, "routed");
  assert.equal(await bal(plexU), b0);
  await L.stop(plexU, ROOM);
});

test("https with a pinned certificate: a matching pin works, a wrong pin refuses before anything is sent", { skip: !hasOpenssl() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-tls-"));
  childProcess.execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2",
    "-subj", "/CN=patv-mediactl", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
  const fp = String(childProcess.execFileSync("openssl", ["x509", "-noout", "-fingerprint", "-sha256", "-in", path.join(dir, "c.pem")])).split("=")[1].trim();
  const cfg2 = { ...mcfg, tlsCert: path.join(dir, "c.pem"), tlsKey: path.join(dir, "k.pem") };
  const { server: s2 } = M.makeServer(cfg2, { plex, streams: M.makeStreams(cfg2, plex, fakeSpawn) });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const keepUrl = process.env.MEDIACTL_URL;
  process.env.MEDIACTL_URL = `https://127.0.0.1:${s2.address().port}`;
  try {
    process.env.MEDIACTL_TLS_SHA256 = fp;
    const r = await L.call("GET", "/streams");
    assert.equal(r.status, 200);
    process.env.MEDIACTL_TLS_SHA256 = "AA:" + fp.slice(3);
    await assert.rejects(L.call("GET", "/streams"), /doesn't match/);
  } finally {
    delete process.env.MEDIACTL_TLS_SHA256;
    process.env.MEDIACTL_URL = keepUrl;
    s2.close();
  }
});
function hasOpenssl() { try { childProcess.execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch (e) { return false; } }
