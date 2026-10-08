// Offline tests for the "Also stream to Twitch" relay (restream.js, 1.99fk): key encryption + masking, input
// checks, owner-only routes + CSRF, desired-relay computation (live AND toggle AND key), the loopback-only worker API.
//   node --test test/restream.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restream-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.RESTREAM_SECRET = "a".repeat(64);
process.env.RESTREAM_TOKEN = "t".repeat(48);
delete process.env.RESTREAM_ALLOW_LOOPBACK;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const R = require(path.join(repo, "restream"));

let T = 1_800_000_000_000;
S._setClock(() => T);
R._setClock(() => T);
const adv = (ms) => { T += ms; };
const KEY = "live_123456789_AbCdEfGhIjKlMnOpQrStUvWxYz0123";
let n = 0;
async function mkUser() {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [id, "user" + n, "User " + n, 100000]);
  return { userId: id, username: "user" + n };
}
async function clear() { for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test"); }
// book a slot and publish to it (live, via rtmp)
async function liveSlot(u) {
  const r = await S.book(u, { minutes: 5 });
  const p = await S.rtmpCallback({ call: "publish", app: "stage", name: r.key, addr: "1.2.3.4", clientid: "c" + r.slot.id });
  assert.equal(p.status, 302);
  return r.slot;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 30, max_concurrent: 4, bookings_per_hour: 50, enabled: true }, "test");
  await R.init();
  const rooms = require(path.join(repo, "rooms"));
  await rooms.setStage(rooms.HOUSE_ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
});
test.afterEach(async () => { await clear(); R._reset(); });

test("crypto: AES-GCM round trip, owner-bound, tamper-proof, fresh IV, masked view", () => {
  const a = R.encrypt(KEY, "u1");
  const b = R.encrypt(KEY, "u1");
  assert.notEqual(a, b, "a fresh IV every time");
  assert.ok(!a.includes(KEY) && !a.includes("live_"), "no plaintext in the blob");
  assert.equal(R.decrypt(a, "u1"), KEY);
  assert.throws(() => R.decrypt(a, "u2"), "bound to its owner (AAD)");
  const p = a.split(".");
  const ct = Buffer.from(p[3], "base64url"); ct[0] ^= 1;
  assert.throws(() => R.decrypt([p[0], p[1], p[2], ct.toString("base64url")].join("."), "u1"), "tampering is caught");
  assert.throws(() => R.decrypt(a, "u1", "b".repeat(64)), "another server's secret can't read it");
  assert.equal(R.mask("0123"), "••••0123");
  assert.equal(R.mask(null), null);
});

test("input checks: key shape, Twitch-only servers (loopback only when allowed)", () => {
  assert.equal(R.cleanKey(" " + KEY + " "), KEY);
  assert.equal(R.cleanKey(""), "");
  for (const bad of ["short", "has space here!", "a/b/c/d/e/f/g", "x".repeat(201)]) assert.throws(() => R.cleanKey(bad), (e) => e.status === 400);
  assert.equal(R.cleanServer(""), R.DEFAULT_SERVER);
  assert.equal(R.cleanServer("auto"), R.DEFAULT_SERVER);
  assert.equal(R.cleanServer("rtmp://live-jfk.twitch.tv/app/"), "rtmp://live-jfk.twitch.tv/app");
  assert.equal(R.cleanServer("rtmps://lhr03.contribute.live-video.net/app"), "rtmps://lhr03.contribute.live-video.net/app");
  for (const bad of ["http://live.twitch.tv/app", "rtmp://evil.example/app", "rtmp://twitch.tv.evil.example/app", "rtmp://u:p@live.twitch.tv/app",
                     "rtmp://live.twitch.tv/app?x=1", "rtmp://127.0.0.1/live", "nonsense"]) {
    assert.throws(() => R.cleanServer(bad), (e) => e.status === 400, bad);
  }
  process.env.RESTREAM_ALLOW_LOOPBACK = "1";
  try { assert.equal(R.cleanServer("rtmp://127.0.0.1:19350/sink"), "rtmp://127.0.0.1:19350/sink"); } finally { delete process.env.RESTREAM_ALLOW_LOOPBACK; }
});

test("storage: saved encrypted, view never has the key, blank key keeps it, delete", async () => {
  const u = await mkUser();
  await assert.rejects(R.saveDest(u.userId, { key: "" }), (e) => e.status === 400, "a first save needs a key");
  const v = await R.saveDest(u.userId, { key: KEY, auto: true }, "t");
  assert.deepEqual({ ...v, updated: 0 }, { service: "twitch", server: R.DEFAULT_SERVER, key: "••••0123", auto: true, updated: 0 });
  const row = await R.destRow(u.userId);
  assert.ok(!JSON.stringify(row).includes(KEY), "the DB row holds no plaintext key");
  const v2 = await R.saveDest(u.userId, { key: "", server: "rtmp://live-jfk.twitch.tv/app", auto: false }, "t");
  assert.equal(v2.key, "••••0123"); assert.equal(v2.server, "rtmp://live-jfk.twitch.tv/app"); assert.equal(v2.auto, false);
  assert.equal(R.decrypt((await R.destRow(u.userId)).key_enc, u.userId), KEY, "the old key kept");
  assert.equal(await R.deleteDest(u.userId), true);
  assert.equal(await R.destRow(u.userId), null);
});

test("desired relays: live AND switched on AND a key saved; auto default; WHIP / embed never", async () => {
  const a = await mkUser(), b = await mkUser(), c = await mkUser();
  const sa = await liveSlot(a);
  const sb = await liveSlot(b);
  const sc = await liveSlot(c);
  assert.deepEqual(await R.desired(), [], "nobody has a key");
  await R.saveDest(a.userId, { key: KEY, auto: true });
  await R.saveDest(b.userId, { key: KEY + "b", auto: false });
  let d = await R.desired();
  assert.deepEqual(d.map((x) => x.id), ["slot:" + sa.id], "a: auto on; b: auto off; c: no key");
  assert.equal(d[0].source, "rtmp://127.0.0.1/live/" + sa.stream, "reads the HLS app over loopback");
  await R.setToggle("slot:" + sb.id, true);
  await R.setToggle("slot:" + sa.id, false);
  d = await R.desired();
  assert.deepEqual(d.map((x) => x.id), ["slot:" + sb.id], "per-slot switches override the default");
  // off air: the heartbeat goes stale
  adv(40000);
  assert.deepEqual(await R.desired(), [], "nothing while off air");
  await S.rtmpCallback({ call: "update_publish", app: "stage", name: "x", addr: "1.2.3.4", clientid: "c" + sb.id });
  assert.deepEqual((await R.desired()).map((x) => x.id), ["slot:" + sb.id], "back on air");
  // WHIP slots can't be relayed
  await runQuery("UPDATE stage_slots SET via = 'whip' WHERE id = ?", [sb.id]);
  assert.deepEqual(await R.desired(), []);
  await S.end(sc.id, "test", "t");
});

test("desired relays: Pepe's main stream follows his nginx-rtmp heartbeat, the admin switch and his key", async () => {
  assert.equal(R.mainLive(), false);
  await S.rtmpCallback({ call: "publish", app: "live", name: "broadcast", addr: "9.9.9.9", clientid: "p" });
  assert.equal(R.mainLive(), true);
  assert.deepEqual(await R.desired(), [], "switch off");
  await R.setToggle(R.MAIN, true);
  assert.deepEqual(await R.desired(), [], "no key yet");
  await R.saveDest(R.MAIN_OWNER, { key: KEY, server: "rtmp://live-jfk.twitch.tv/app" });
  let d = await R.desired();
  assert.deepEqual(d.map((x) => [x.id, x.source]), [["main", "rtmp://127.0.0.1/live/broadcast"]]);
  const sync = await R.workerSync({ status: {} });
  assert.deepEqual(sync.relays, [{ id: "main", source: "rtmp://127.0.0.1/live/broadcast", target: "rtmp://live-jfk.twitch.tv/app/" + KEY }]);
  adv(25000);
  await S.rtmpCallback({ call: "update_publish", app: "live", name: "broadcast", addr: "9.9.9.9", clientid: "p" });
  adv(25000);
  assert.equal((await R.desired()).length, 1, "the on_update heartbeat keeps it live");
  adv(31000);
  assert.equal((await R.desired()).length, 0, "stale heartbeat = off air");
  await R.setToggle(R.MAIN, false);
  await R.deleteDest(R.MAIN_OWNER);
});

test("worker sync: status is stored scrubbed; a key this server can't decrypt is never handed out", async () => {
  const u = await mkUser();
  const s = await liveSlot(u);
  await R.saveDest(u.userId, { key: KEY, auto: true });
  let r = await R.workerSync({ worker: { version: "x" }, status: { ["slot:" + s.id]: { state: "live", kbps: 6500, detail: "pushing to rtmp://live.twitch.tv/app/" + KEY } } });
  assert.equal(r.relays.length, 1);
  const st = R.statusOf("slot:" + s.id, true);
  assert.equal(st.state, "live");
  assert.ok(!JSON.stringify(st).includes(KEY) && !JSON.stringify(st).includes("rtmp://"), "no URL / key in the status");
  assert.match(st.warn, /over Twitch/);
  // a row from another server's secret (a staging DB refresh): refused, shown as an error
  await runQuery("UPDATE restream_dest SET key_enc = ? WHERE owner = ?", [R.encrypt(KEY, u.userId, "z".repeat(64)), u.userId]);
  r = await R.workerSync({ status: {} });
  assert.deepEqual(r.relays, []);
  assert.equal(R.statusOf("slot:" + s.id, true).state, "error");
  // worker silent -> error
  adv(30000);
  assert.match(R.statusOf("slot:" + s.id, true).detail, /isn't running/);
});

test("HTTP: owner-only, CSRF on writes, keys never returned, loopback + token worker API", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => {
    const id = req.headers["x-test-user"];
    req.user = id ? { userId: id, username: "n-" + id, class: req.headers["x-test-class"] || "pleb" } : null;
    next();
  };
  R.register(app, { addUser });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const H = (u, extra = {}) => ({ "Content-Type": "application/json", "X-Requested-With": "fetch", ...(u ? { "x-test-user": u } : {}), ...extra });
  const post = (p, u, body, extra) => fetch(base + p, { method: "POST", headers: H(u, extra), body: JSON.stringify(body || {}) });
  try {
    const a = await mkUser(), b = await mkUser();
    assert.equal((await post("/api/restream/me/dest", null, { key: KEY })).status, 401);
    assert.equal((await post("/api/restream/me/dest", a.userId, { key: KEY }, { "X-Requested-With": "" })).status, 403, "no X-Requested-With");
    assert.equal((await post("/api/restream/me/dest", a.userId, { key: KEY }, { Origin: "https://evil.example" })).status, 403, "cross-site");
    let res = await post("/api/restream/me/dest", a.userId, { key: KEY, auto: true });
    let txt = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!txt.includes(KEY) && txt.includes("••••0123"), "masked only");
    res = await fetch(base + "/api/restream/me", { headers: H(a.userId) });
    txt = await res.text();
    assert.ok(!txt.includes(KEY) && !txt.includes("key_enc") && txt.includes("••••0123"));
    assert.equal(res.headers.get("cache-control"), "no-store");
    // b can't touch a's slot
    const s = await liveSlot(a);
    assert.equal((await post("/api/restream/slot/" + s.id + "/toggle", b.userId, { on: false })).status, 404);
    assert.equal((await post("/api/restream/slot/" + s.id + "/toggle", a.userId, { on: false })).status, 200);
    assert.equal(await R.toggleOf("slot:" + s.id), false);
    assert.equal((await post("/api/restream/slot/" + s.id + "/toggle", b.userId, { on: true })).status, 404);
    // b without a key can't switch on their own slot
    const sb = await liveSlot(b);
    assert.equal((await post("/api/restream/slot/" + sb.id + "/toggle", b.userId, { on: true })).status, 400);
    // admin endpoints
    assert.equal((await fetch(base + "/api/restream/admin", { headers: H(a.userId) })).status, 403);
    assert.equal((await post("/api/restream/admin/main/dest", a.userId, { key: KEY })).status, 403);
    assert.equal((await post("/api/restream/admin/main/toggle", "staff1", { on: true }, { "x-test-class": "Staff" })).status, 403, "staff can't run Pepe's relay");
    assert.equal((await post("/api/restream/admin/main/dest", "adm", { key: KEY }, { "x-test-class": "Admin" })).status, 200);
    assert.equal((await post("/api/restream/admin/main/toggle", "adm", { on: true }, { "x-test-class": "Admin" })).status, 200);
    res = await fetch(base + "/api/restream/admin", { headers: H("staff1", { "x-test-class": "Staff" }) });
    txt = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!txt.includes(KEY), "admin view is masked too");
    assert.equal((await post("/api/restream/admin/slot/" + s.id + "/off", "staff1", {}, { "x-test-class": "Staff" })).status, 200, "staff can switch a relay off");
    // the worker API: token + loopback + no proxy headers
    const W = (hdr) => fetch(base + "/api/restream/worker/sync", { method: "POST", headers: { "Content-Type": "application/json", ...hdr }, body: "{}" });
    assert.equal((await W({})).status, 403, "no token");
    assert.equal((await W({ "X-Restream-Token": "x".repeat(48) })).status, 403, "wrong token");
    assert.equal((await W({ "X-Restream-Token": process.env.RESTREAM_TOKEN, "X-Forwarded-For": "1.2.3.4" })).status, 403, "through the proxy");
    res = await W({ "X-Restream-Token": process.env.RESTREAM_TOKEN });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.ok(Array.isArray(j.relays));
    const S2 = (hdr) => fetch(base + "/api/restream/worker/state", { method: "POST", headers: { "Content-Type": "application/json", ...hdr }, body: "{}" });
    assert.equal((await S2({})).status, 403, "state needs the token too");
    res = await S2({ "X-Restream-Token": process.env.RESTREAM_TOKEN });
    txt = await res.text();
    assert.equal(res.status, 200);
    assert.ok(txt.includes('"main"') && !txt.includes(KEY), "masked state for ops");
    await R.setToggle(R.MAIN, false);
    await R.deleteDest(R.MAIN_OWNER);
  } finally { srv.close(); }
});
