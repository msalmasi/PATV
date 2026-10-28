"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "golive-discord-")));
delete process.env.STAGING; delete process.env.TWITCH_CLIENT_ID;
process.env.SECRET_KEY = "test-only";
process.env.PUBLIC_BASE_URL = "https://publicaccess.tv";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const g = require(path.join(repo, "golive")), rooms = require(path.join(repo, "rooms")), pa = require(path.join(repo, "padaccess"));
const admin = { userId: "admin-user", username: "admin", class: "Admin" };
const express = require("express"), app = express();
app.set("views", path.join(repo, "views")); app.set("view engine", "ejs");
app.use(express.json());
app.use((req, res, next) => { req.t = require(path.join(repo, "i18n")).tFor("en"); next(); });
let calls = [], send = async (p, b) => { calls.push({ p, b }); return { ok: true, id: "test" }; };
g.register(app, { noTimers: true, addUser: (req, res, next) => { req.user = req.get("test-user") === "admin" ? admin : { userId: "stream-user", class: "pleb" }; next(); }, discordBridge: (...args) => send(...args) });
let clock = 2000000000000, seq = 0, server, base;
g._setClock(() => clock);
const cfg = { enabled: true, channel_id: "1206395925191200790", role_id: "", max_per_hour: 6 };
async function start(extra = {}) {
  const result = await g.onLive({ key: "test:" + (++seq), roomId: "patv:lounge", userId: "stream-user", display: "Streamer", what: "@boxing live", source: "stage", ...extra });
  await g._drainDiscord(); return result;
}
async function post(route, body, user = "admin", headers = {}) {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "test-user": user, ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
test.before(async () => {
  await runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, displayname TEXT, class TEXT, camfrogUsername TEXT, archived_at INTEGER, points_balance INTEGER DEFAULT 0)");
  for (const [id, name, cls] of [["admin-user", "admin", "Admin"], ["stream-user", "streamer", "pleb"], ["second-user", "second", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, class) VALUES (?, ?, ?)", [id, name, cls]);
  }
  await rooms.init(); await pa.init(); await g.init(); await require(path.join(repo, "chatlog")).init();
  await pa.setLevel(admin, await rooms.get("patv:lounge"), "public");
  server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.beforeEach(async () => {
  await g._drainDiscord(); clock += 7200000; calls = [];
  await g.saveDiscordSettings(admin, cfg);
  await g.setPadAnnounce(admin, "patv:lounge", true);
});
test.after(async () => { await g._drainDiscord(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
test("defaults ship disabled, admin changes validate and audit", async () => {
  await runQuery("DELETE FROM discord_golive"); await runQuery("INSERT INTO discord_golive (id) VALUES (1)");
  assert.deepEqual(await g.discordSettings(), { ...cfg, enabled: false });
  await assert.rejects(g.saveDiscordSettings({ userId: "x", class: "Staff" }, cfg), { status: 403 });
  for (const bad of [{ enabled: "true" }, { channel_id: "" }, { channel_id: "oops" }, { role_id: "@boxing" }, { max_per_hour: 0 }, { max_per_hour: 1.5 }]) {
    assert.equal((await post("/api/admin/discord-golive", { ...cfg, ...bad })).status, 400);
  }
  assert.equal((await post("/api/admin/discord-golive", cfg, "member")).status, 403);
  assert.equal((await post("/api/admin/discord-golive", cfg, "admin", { Origin: "https://elsewhere.invalid" })).status, 403);
  assert.equal((await post("/api/admin/discord-golive", cfg, "admin", { "X-Requested-With": "" })).status, 403);
  assert.equal((await post("/api/admin/discord-golive", cfg)).status, 200);
  const rows = await require(path.join(repo, "adminaudit")).recent("discord_golive.settings");
  assert.equal(rows[0].detail.before.enabled, false); assert.equal(rows[0].detail.after.enabled, true);
});
test("public first publish sends correct body, duplicate and reconnect do not", async () => {
  const slot = { id: "first", room_id: "patv:lounge", userId: "stream-user", username: "streamer", title: "x".repeat(170) + " @boxing", source: "library" };
  await g.onSlot(slot); await g._drainDiscord();
  assert.equal(calls.length, 1); assert.equal(calls[0].p, "/stage/golive");
  assert.equal(calls[0].b.title, slot.title); assert.equal(calls[0].b.kind, "plex");
  assert.equal(calls[0].b.url, "https://publicaccess.tv/p/patv-lounge");
  assert.equal(calls[0].b.pad.slug, "patv-lounge"); assert.equal(calls[0].b.channel_id, cfg.channel_id);
  await g.onSlot(slot); await g.onSlot({ ...slot, id: "reconnect" }); await g._drainDiscord(); assert.equal(calls.length, 1);
});
test("separate Discord pad gap applies to unbridged pads and allows exactly ten minutes", async () => {
  await start(); clock += 1000; await start({ userId: "second-user" }); assert.equal(calls.length, 1);
  clock += g.PAD_GAP_MS; await start({ userId: "admin-user" }); assert.equal(calls.length, 2);
});
test("switch off, no channel, owner opt-out and staging never send", async () => {
  await g.saveDiscordSettings(admin, { ...cfg, enabled: false }); await start();
  await runQuery("UPDATE discord_golive SET enabled=1, channel_id=''"); clock += g.RESTART_MS; await start();
  await g.saveDiscordSettings(admin, cfg); await g.setPadAnnounce(admin, "patv:lounge", false); clock += g.RESTART_MS; await start();
  await g.setPadAnnounce(admin, "patv:lounge", true); process.env.STAGING = "1";
  try { clock += g.RESTART_MS; await start(); assert.equal((await post("/api/admin/discord-golive/test", {})).status, 409); } finally { delete process.env.STAGING; }
  assert.equal(calls.length, 0);
});
test("adult, unlisted, members and approved pads cannot announce", async () => {
  for (const column of ["adult", "listed"]) {
    await runQuery("UPDATE rooms_registry SET " + column + "=? WHERE room_id='patv:lounge'", [column === "adult" ? 1 : 0]);
    await rooms.loadCache(); await start(); clock += g.RESTART_MS;
    await runQuery("UPDATE rooms_registry SET " + column + "=? WHERE room_id='patv:lounge'", [column === "adult" ? 0 : 1]); await rooms.loadCache();
  }
  for (const level of ["members", "approved"]) { await pa.setLevel(admin, await rooms.get("patv:lounge"), level); await start(); clock += g.RESTART_MS; }
  await pa.setLevel(admin, await rooms.get("patv:lounge"), "public"); assert.equal(calls.length, 0);
});
test("private identities and cam/adult slots never disclose activity", async () => {
  const quotes = require(path.join(repo, "quotes")), crypto = require("crypto");
  const hash = (s) => crypto.createHash("sha256").update("pepe-hidden:" + s).digest("hex").slice(0, 20);
  quotes.setHidden([hash("u:stream-user")]); await start(); clock += g.RESTART_MS;
  quotes.setHidden([hash("linkedcf")]); await runQuery("UPDATE users SET camfrogUsername='linkedcf' WHERE userId='stream-user'");
  await start(); quotes.setHidden([]); await runQuery("UPDATE users SET camfrogUsername=NULL WHERE userId='stream-user'"); clock += g.RESTART_MS;
  for (const extra of [{ source: "cam" }, { nsfw: 1 }]) {
    await g.onSlot({ id: "private" + (++seq), room_id: "patv:lounge", userId: "stream-user", username: "secret", ...extra });
    await g._drainDiscord(); clock += g.RESTART_MS;
  }
  assert.equal(calls.length, 0);
});
test("global hourly limit is durable and atomic across concurrent starts", async () => {
  await g.saveDiscordSettings(admin, { ...cfg, max_per_hour: 1 });
  await runQuery("UPDATE rooms_registry SET listed=1 WHERE room_id='patv:staff'"); await rooms.loadCache();
  await pa.setLevel(admin, await rooms.get("patv:staff"), "public");
  await Promise.all([start(), start({ roomId: "patv:staff", userId: "second-user" })]); assert.equal(calls.length, 1);
  clock += g.RESTART_MS; await start(); assert.equal(calls.length, 1);
  clock += 3600000; await start(); assert.equal(calls.length, 2);
});
test("Discord delivery does not hold up onLive and failures preserve fan-outs", async () => {
  const old = send; let release, began;
  const waiting = new Promise((r) => { began = r; });
  send = async () => { began(); return new Promise((r) => { release = r; }); };
  try {
    const result = await g.onLive({ key: "slow", roomId: "patv:lounge", userId: "stream-user", display: "Star", source: "stage" });
    assert.equal(result.error, undefined); await waiting; release({ error: "offline" }); await g._drainDiscord();
    clock += g.RESTART_MS; send = async () => { throw new Error("offline"); };
    await require(path.join(repo, "inbox")).ready;
    await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES ('second-user', 'room', 'patv:lounge', ?)", [clock]);
    const result2 = await start(); assert.equal(result2.error, undefined); assert.equal(result2.notified, 1);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id='second-user' AND kind='golive'"))[0].n, 1);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM golive_log WHERE key='slow'"))[0].n, 1);
  } finally { send = old; }
});
test("admin page renders and test alert is audited, marked, capped, and works while disabled", async () => {
  await g.saveDiscordSettings(admin, { ...cfg, enabled: false, max_per_hour: 1 });
  assert.equal((await fetch(base + "/admin/discord-golive")).status, 403);
  const page = await fetch(base + "/admin/discord-golive", { headers: { "test-user": "admin" } });
  assert.equal(page.status, 200); assert.match(await page.text(), /Send a test alert/);
  assert.equal((await post("/api/admin/discord-golive/test", {}, "member")).status, 403);
  assert.equal((await post("/api/admin/discord-golive/test", {})).status, 200);
  assert.equal(calls[0].b.test, true); assert.equal(calls[0].b.role_id, undefined);
  assert.equal((await post("/api/admin/discord-golive/test", {})).status, 429);
  assert.ok((await require(path.join(repo, "adminaudit")).recent("discord_golive.test")).length);
});

test("queue title changes never send another Discord alert", async () => {
  await g.nowPlaying({ roomId: "patv:lounge", userId: "stream-user", display: "Star", what: "Next film" });
  await g._drainDiscord(); assert.equal(calls.length, 0);
});
