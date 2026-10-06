// Offline tests for paid Main Stage slots (mainstage.js): holds, per-minute billing, refunds on
// every exit path, restart reconciliation, nginx-rtmp key checks, relay auth, the callback route.
//   node --test test/mainstage.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));

let T = 1_800_000_000_000;
S._setClock(() => T);
const adv = (ms) => { T += ms; };
const PRICE = 100;
const START = 100000;

async function balance(userId) { return (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [userId]))[0].b; }
async function revenue() {
  const r = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims WHERE flow = 'stage_slot'");
  const j = await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes");
  return { reserve: -r[0].t, jackpot: j[0].t };
}
let n = 0;
async function mkUser(bal = START) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [id, "user" + n, "User " + n, bal]);
  return { userId: id, username: "user" + n };
}
// end everything open so the next test can book (max_concurrent = 1)
async function clear() { for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test"); }
const pub = (name, extra = {}) => S.rtmpCallback({ call: "publish", app: "stage", name, addr: "1.2.3.4", clientid: "7", ...extra });
const upd = (name, extra = {}) => S.rtmpCallback({ call: "update_publish", app: "stage", name, addr: "1.2.3.4", clientid: "7", ...extra });
const done = (name, extra = {}) => S.rtmpCallback({ call: "publish_done", app: "stage", name, addr: "1.2.3.4", clientid: "7", ...extra });
// `secs` of streaming: on_update every 10 s, the billing tick every 5 s
async function stream(name, secs, extra) {
  for (let t = 0; t < secs; t += 5) {
    adv(5000);
    if (t % 10 === 5) assert.equal((await upd(name, extra)).status, 200);
    await S.tick();
  }
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await S.init();
  await S.setConfig({ price_per_min: PRICE, min_minutes: 2, max_minutes: 30, max_concurrent: 1, start_window_min: 10,
                      idle_grace_min: 5, bookings_per_hour: 50, revenue_vault: "reserve", enabled: true }, "test");
});
test.afterEach(clear);

test("billing math: per started minute, never more than the hold", () => {
  const s = { held: 500, max_minutes: 5, price_per_min: 100 };
  assert.equal(S.billedMinutes(0), 0);
  assert.equal(S.billedMinutes(1), 1);
  assert.equal(S.billedMinutes(60000), 1);
  assert.equal(S.billedMinutes(60001), 2);
  assert.equal(S.chargeFor(s, 0), 0);
  assert.equal(S.chargeFor(s, 125000), 300);
  assert.equal(S.chargeFor(s, 10 * 60000), 500);
});

test("booking holds the full max up front; refusals move nothing", async () => {
  const u = await mkUser();
  await assert.rejects(S.book(u, { minutes: 1 }), /between 2 and 30/);
  await assert.rejects(S.book(u, { minutes: 31 }), /between 2 and 30/);
  await assert.rejects(S.book(u, { minutes: "x" }), /between/);
  const poor = await mkUser(150);
  await assert.rejects(S.book(poor, { minutes: 2 }), (e) => e.status === 402);
  assert.equal(await balance(poor.userId), 150);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE userId = ?", [poor.userId]))[0].n, 0);

  const r = await S.book(u, { minutes: 10 });
  assert.equal(r.slot.held, 1000);
  assert.equal(r.slot.status, "waiting");
  assert.ok(r.key.length >= 32 && /^[A-Za-z0-9_-]+$/.test(r.key));
  assert.equal(await balance(u.userId), START - 1000);
  const row = await S.getSlot(r.slot.id);
  assert.notEqual(row.key_hash, r.key, "key stored hashed, not in clear");
  assert.ok(!r.slot.hls.includes(r.key), "public HLS name never contains the key");
  const tx = await getQuery("SELECT points FROM transactions WHERE userId = ?", [u.userId]);
  assert.deepEqual(tx.map((x) => x.points), [-1000]);
  // one stage: a second booker is refused, and so is a second slot for the same user
  const v = await mkUser();
  await assert.rejects(S.book(v, { minutes: 5 }), (e) => e.status === 409);
  await assert.rejects(S.book(u, { minutes: 5 }), (e) => e.status === 409);
  assert.equal(await balance(v.userId), START);
});

test("never goes live -> full refund after the start window, nothing earned", async () => {
  const u = await mkUser();
  const before = await revenue();
  const r = await S.book(u, { minutes: 10 });
  adv(9 * 60000); await S.tick();
  assert.equal((await S.getSlot(r.slot.id)).status, "waiting");
  adv(2 * 60000); await S.tick();
  const s = await S.getSlot(r.slot.id);
  assert.equal(s.status, "ended"); assert.equal(s.end_reason, "never_live");
  assert.equal(s.charged, 0); assert.equal(s.refunded, 1000);
  assert.equal(await balance(u.userId), START);
  assert.deepEqual(await revenue(), before);
  assert.equal(s.key_hash, null, "key dies with the slot");
  assert.equal((await pub(r.key)).status, 403, "expired key rejected");
});

test("on_publish: valid key redirects to the slot stream; wrong / used / public-name keys rejected", async () => {
  const u = await mkUser();
  const r = await S.book(u, { minutes: 5 });
  assert.equal((await pub("nope-" + r.key)).status, 403);
  assert.equal((await pub("")).status, 403);
  assert.equal((await pub(r.slot.stream)).status, 403, "the public stream name is not a key");
  assert.equal((await pub(r.key, { app: "other" })).status, 403, "other applications refused");
  const ok = await pub(r.key);
  assert.equal(ok.status, 302);
  assert.equal(ok.location, "rtmp://127.0.0.1/live/" + r.slot.stream, "pushed to the HLS app under the public name");
  assert.ok(r.slot.stream.startsWith(S.STREAM_PREFIX) && !ok.location.includes(r.key));
  // the HLS application: Pepe's key passes; slot pushes only from loopback and only while open
  const out = (call, name, extra = {}) => S.rtmpCallback({ call, app: "live", name, addr: "127.0.0.1", clientid: "3", ...extra });
  assert.equal((await out("publish", "broadcast", { addr: "5.6.7.8" })).status, 200, "Pepe's key passes through");
  assert.equal((await out("update_publish", "broadcast")).status, 200);
  assert.equal((await pub("broadcast")).status, 403, "Pepe's key is not a slot key on the ingest app");
  assert.equal((await out("publish", r.slot.stream)).status, 200, "the local push is allowed");
  assert.equal((await out("publish", r.slot.stream, { addr: "5.6.7.8" })).status, 403, "nobody else may publish a slot name");
  assert.equal((await out("publish", r.key)).status, 403, "keys are never accepted on the HLS app");
  assert.equal((await out("publish", "anything")).status, 403);
  assert.equal((await out("update_publish", r.slot.stream)).status, 200);
  await S.end(r.slot.id, "owner_ended", u.username);
  assert.equal((await pub(r.key)).status, 403, "used key dead after the slot");
  assert.equal((await upd(r.slot.stream, { clientid: "99" })).status, 403, "an ended slot's stream is dropped");
  assert.equal((await out("update_publish", r.slot.stream)).status, 403, "and its HLS push too");
});

test("relay keys: only the server's HMAC, only from loopback", async () => {
  const u = await mkUser();
  const r = await S.book(u, { minutes: 5 });
  const rk = S.relayKey(r.slot.id);
  assert.equal(S.parseRelayKey(rk), r.slot.id);
  assert.equal(S.parseRelayKey(rk.slice(0, -1) + (rk.endsWith("A") ? "B" : "A")), null);
  assert.equal((await pub(rk, { addr: "8.8.8.8" })).status, 403);
  const forged = "r." + r.slot.id + "." + "x".repeat(32);
  assert.equal((await pub(forged, { addr: "127.0.0.1" })).status, 403);
  const ok = await pub(rk, { addr: "127.0.0.1", clientid: "55" });
  assert.equal(ok.status, 302); assert.equal(ok.location, "rtmp://127.0.0.1/live/" + r.slot.stream);
});

test("per-minute billing while live; owner ends -> refund the rest, revenue to the Reserve", async () => {
  const u = await mkUser();
  const before = await revenue();
  const r = await S.book(u, { minutes: 10 });
  adv(30000); await S.tick();                       // waiting: nothing billed
  assert.equal((await S.getSlot(r.slot.id)).live_ms, 0);
  assert.equal((await pub(r.key)).status, 302);
  await S.tick();
  await stream(r.slot.stream, 150);                 // 2.5 min live -> 3 started minutes
  let s = await S.getSlot(r.slot.id);
  assert.ok(s.live_ms >= 145000 && s.live_ms <= 155000, "live_ms " + s.live_ms);
  assert.equal(s.charged, 300);
  assert.ok(S.isLive(s));
  assert.equal((await done(r.slot.stream)).status, 200);
  await S.tick(); adv(60000); await S.tick();        // off air: no billing
  assert.equal((await S.getSlot(r.slot.id)).charged, 300);
  const res = await S.end(r.slot.id, "owner_ended", u.username);
  assert.deepEqual([res.charged, res.refund], [300, 700]);
  assert.equal(await balance(u.userId), START - 300);
  const after = await revenue();
  assert.equal(after.reserve - before.reserve, 300);
  assert.equal(after.jackpot, before.jackpot);
  assert.equal(await S.end(r.slot.id, "again", "x"), null, "settling twice does nothing");
  assert.equal(await balance(u.userId), START - 300);
});

test("heartbeat lost -> billing stops; off air past the grace -> ends idle with refund", async () => {
  const u = await mkUser();
  const r = await S.book(u, { minutes: 10 });
  await pub(r.key, { clientid: "11" });
  await S.tick();
  await stream(r.slot.stream, 60, { clientid: "11" });
  // nginx/OBS vanish without publish_done: no more on_update
  for (let i = 0; i < 12; i++) { adv(5000); await S.tick(); }
  let s = await S.getSlot(r.slot.id);
  assert.ok(s.live_ms <= 95000, "stops accruing within the stale window: " + s.live_ms);
  assert.equal(s.publishing, 0);
  for (let i = 0; i < 60; i++) { adv(5000); await S.tick(); }
  s = await S.getSlot(r.slot.id);
  assert.equal(s.status, "ended"); assert.equal(s.end_reason, "idle");
  assert.equal(s.charged, 200);
  assert.equal(await balance(u.userId), START - 200);
});

test("time up: live through the whole max -> charged exactly the hold, nothing refunded, dropped", async () => {
  const u = await mkUser();
  const r = await S.book(u, { minutes: 2 });
  await pub(r.key, { clientid: "12" }); await S.tick();
  await stream(r.slot.stream, 130, { clientid: "12" }).catch(() => {});   // the last on_update is refused
  const s = await S.getSlot(r.slot.id);
  assert.equal(s.status, "ended"); assert.equal(s.end_reason, "time_up");
  assert.equal(s.charged, 200); assert.equal(s.refunded, 0);
  assert.equal(await balance(u.userId), START - 200);
  assert.equal((await upd(r.slot.stream, { clientid: "12" })).status, 403, "kicked off nginx");
});

test("admin cut refunds the unused part and drops the publisher; ban blocks booking + publishing", async () => {
  const u = await mkUser();
  const r = await S.book(u, { minutes: 10 });
  await pub(r.key, { clientid: "13" }); await S.tick();
  await stream(r.slot.stream, 40, { clientid: "13" });
  const res = await S.end(r.slot.id, "cut", "admin");
  assert.equal(res.charged, 100); assert.equal(res.refund, 900);
  assert.equal((await upd(r.slot.stream, { clientid: "13" })).status, 403);
  assert.equal(await balance(u.userId), START - 100);

  const r2 = await S.book(u, { minutes: 5 });
  await S.ban(u.username, "spam", "admin");               // ban also cuts the open slot (full refund: never live)
  assert.equal((await S.getSlot(r2.slot.id)).end_reason, "banned");
  assert.equal(await balance(u.userId), START - 100);
  await assert.rejects(S.book(u, { minutes: 5 }), (e) => e.status === 403);
  assert.equal(await balance(u.userId), START - 100);
  await S.unban(u.userId, "admin");
  const r3 = await S.book(u, { minutes: 5 });
  assert.equal(r3.slot.status, "waiting");
});

test("restart: expired slots settle on startup, live ones resume via name lookup, downtime unbilled", async () => {
  const u = await mkUser();
  const r = await S.book(u, { minutes: 10 });
  await pub(r.key, { clientid: "14" }); await S.tick();
  await stream(r.slot.stream, 60, { clientid: "14" });
  const liveBefore = (await S.getSlot(r.slot.id)).live_ms;
  // "restart": memory gone, 2 min of downtime
  S._clients.clear(); S._lastTick.clear();
  adv(120000);
  assert.equal(await S.reconcile(), 0, "still inside its window -> resumes");
  let s = await S.getSlot(r.slot.id);
  assert.equal(s.status, "active"); assert.equal(s.publishing, 0, "stale heartbeat cleared");
  // nginx's next on_update (clientid unknown now) finds it by the redirected name, or by the key
  assert.equal((await upd(r.slot.stream, { clientid: "14" })).status, 200);
  S._clients.clear();
  assert.equal((await upd(r.key, { clientid: "15" })).status, 200);
  await S.tick(); adv(5000); await S.tick();
  s = await S.getSlot(r.slot.id);
  assert.ok(s.live_ms - liveBefore <= 5000, "the downtime was not billed");

  // a slot whose deadline passed while the server was down is settled at startup
  S._clients.clear(); S._lastTick.clear();
  adv(S.deadline(s) - T + 1000);
  assert.equal(await S.reconcile(), 1);
  s = await S.getSlot(r.slot.id);
  assert.equal(s.status, "ended"); assert.equal(s.end_reason, "restart");
  assert.equal(await balance(u.userId), START - s.charged);
  assert.equal(s.charged + s.refunded, s.held);
});

test("revenue can route to the casino jackpot instead", async () => {
  await S.setConfig({ revenue_vault: "jackpot" }, "test");
  try {
    const u = await mkUser();
    const before = await revenue();
    const r = await S.book(u, { minutes: 5 });
    await pub(r.key, { clientid: "16" }); await S.tick();
    await stream(r.slot.stream, 20, { clientid: "16" });
    await S.end(r.slot.id, "owner_ended", "x");
    const after = await revenue();
    assert.equal(after.jackpot - before.jackpot, 100);
    assert.equal(after.reserve, before.reserve);
  } finally { await S.setConfig({ revenue_vault: "reserve" }, "test"); }
});

test("rate limit: bookings per user per hour", async () => {
  await S.setConfig({ bookings_per_hour: 2 }, "test");
  try {
    const u = await mkUser();
    for (let i = 0; i < 2; i++) { const r = await S.book(u, { minutes: 2 }); await S.end(r.slot.id, "owner_ended", "x"); }
    await assert.rejects(S.book(u, { minutes: 2 }), (e) => e.status === 429);
    adv(3601 * 1000);
    const r = await S.book(u, { minutes: 2 });
    assert.ok(r.slot.id);
  } finally { await S.setConfig({ bookings_per_hour: 50 }, "test"); }
});

// a fake ffmpeg: records what was written, can be told to exit
function fakeSpawn(log) {
  return (args) => {
    const p = new EventEmitter();
    p.args = args; p.stdin = new PassThrough(); p.stderr = new EventEmitter(); p.bytes = 0; p.killed = false;
    p.stdin.on("data", (d) => { p.bytes += d.length; });
    p.kill = () => { p.killed = true; p.emit("exit", null, "SIGKILL"); };
    log.push(p);
    return p;
  };
}

test("browser relay: owner-only on every chunk, in order, killed on end, bitrate capped", async () => {
  const spawned = [];
  S._setSpawn(fakeSpawn(spawned));
  const u = await mkUser(), other = await mkUser();
  const r = await S.book(u, { minutes: 5 });
  const chunk = Buffer.alloc(1000, 1);
  await assert.rejects(S.relayChunk(other, r.slot.id, 0, chunk), (e) => e.status === 403);
  await assert.rejects(S.relayChunk(null, r.slot.id, 0, chunk), (e) => e.status === 403);
  assert.equal(spawned.length, 0);
  let x = await S.relayChunk(u, r.slot.id, 1, chunk);
  assert.equal(x.restart, true, "must start at chunk 0");
  x = await S.relayChunk(u, r.slot.id, 0, chunk);
  assert.equal(x.ok, true); assert.equal(spawned.length, 1);
  const args = spawned[0].args.join(" ");
  assert.ok(args.includes("rtmp://127.0.0.1/stage/r." + r.slot.id + "."), "publishes to the local ingest app with the relay key");
  assert.ok(!args.includes(S.relayKey(r.slot.id) + "x"));
  adv(1000); x = await S.relayChunk(u, r.slot.id, 1, chunk); assert.equal(x.ok, true);
  adv(1000); x = await S.relayChunk(u, r.slot.id, 3, chunk); assert.equal(x.restart, true, "gap -> restart");
  x = await S.relayChunk(u, r.slot.id, 0, chunk);                 // restart kills the old ffmpeg
  assert.equal(spawned.length, 2);
  await assert.rejects(S.relayChunk(u, r.slot.id, 1, Buffer.alloc(0)), (e) => e.status === 400);
  // bitrate cap: ~2 MB a second for 5 s = 16 Mbit/s
  const big = Buffer.alloc(2 * 1024 * 1024, 2);
  let capped = null;
  for (let i = 1; i < 8 && !capped; i++) {
    adv(1000);
    try { await S.relayChunk(u, r.slot.id, i, big); } catch (e) { capped = e; }
  }
  assert.ok(capped && capped.status === 413, "over the cap is stopped");
  assert.equal(S._relays.has(r.slot.id), false);
  // ended slot: relay refused and stopped
  x = await S.relayChunk(u, r.slot.id, 0, chunk);
  assert.ok(S._relays.has(r.slot.id));
  await S.end(r.slot.id, "owner_ended", u.username);
  assert.equal(S._relays.has(r.slot.id), false, "relay stopped when the slot ends");
  await assert.rejects(S.relayChunk(u, r.slot.id, 1, chunk), (e) => e.status === 410);
});

test("HTTP: the rtmp callback answers only straight from loopback; relay route checks the session", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const addUser = (req, res, next) => { req.user = req.headers["x-test-user"] ? { userId: req.headers["x-test-user"], username: "t", class: "pleb" } : null; next(); };
  S.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  try {
    const u = await mkUser();
    const r = await S.book(u, { minutes: 5 });
    const form = (o) => new URLSearchParams(o).toString();
    const hdr = { "Content-Type": "application/x-www-form-urlencoded" };
    let res = await fetch(base + "/api/stage/rtmp", { method: "POST", headers: hdr, body: form({ call: "publish", app: "stage", name: "bad", addr: "1.1.1.1", clientid: "1" }), redirect: "manual" });
    assert.equal(res.status, 403);
    res = await fetch(base + "/api/stage/rtmp", { method: "POST", headers: hdr, body: form({ call: "publish", app: "stage", name: r.key, addr: "1.1.1.1", clientid: "1" }), redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "rtmp://127.0.0.1/live/" + r.slot.stream);
    res = await fetch(base + "/api/stage/rtmp", { method: "POST", headers: { ...hdr, "X-Forwarded-For": "9.9.9.9" }, body: form({ call: "publish", app: "stage", name: r.key }), redirect: "manual" });
    assert.equal(res.status, 403, "through the public proxy = refused");
    res = await fetch(base + "/api/stage/slots/" + r.slot.id + "/relay?seq=0", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.alloc(10) });
    assert.equal(res.status, 401);
    res = await fetch(base + "/api/stage/slots/" + r.slot.id + "/relay?seq=0", { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-test-user": "someone-else" }, body: Buffer.alloc(10) });
    assert.equal(res.status, 403);
    res = await fetch(base + "/api/stage/slots/" + r.slot.id + "/relay?seq=0", { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-test-user": u.userId }, body: Buffer.alloc(10) });
    assert.equal(res.status, 200);
    res = await fetch(base + "/api/stage/admin/cut", { method: "POST", headers: { "Content-Type": "application/json", "x-test-user": u.userId }, body: "{}" });
    assert.equal(res.status, 403, "not staff");
    res = await fetch(base + "/api/stage/cut", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "bot" }) });
    assert.deepEqual(await res.json(), { ok: true, cut: 1 });
    assert.equal(await balance(u.userId), START);
  } finally { srv.close(); }
});

test("money is conserved: balances + revenue = what everyone started with", async () => {
  const users = await getQuery("SELECT COUNT(*) AS n, SUM(points_balance) AS b FROM users");
  const open = await getQuery("SELECT COALESCE(SUM(held),0) AS h FROM stage_slots WHERE settled = 0");
  const rev = await revenue();
  const starts = await getQuery("SELECT COALESCE(SUM(points),0) AS t FROM transactions");
  // every user started with START except the one made with 150
  assert.equal(users[0].b + open[0].h + rev.reserve + rev.jackpot, (users[0].n - 1) * START + 150);
  assert.equal(starts[0].t, -(rev.reserve + rev.jackpot) - open[0].h, "ledger rows net to what was charged");
});
