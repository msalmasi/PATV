// Offline tests for 1.99?? 📼 PLEX FROM CHAT (plexchat.js - Pepe's POST /api/medialib/bot), end to end against the REAL
// media-control service (deploy/mediactl) with a mocked Plex (movies + two shows) and a fake ffmpeg, on a temp DB:
// the bot token, speaker resolution (linked login / CF auto account / no account / user_id / archived), access (off, member
// free, paid price 400 / 409), the pad's visibility (Approved, 18+), preflight (own slot, cap, busy pad, encoder busy), search
// (never a file; a show + season row; exact flags), the controls (control_denied, seek_rel), queueing next (starter / not
// starter / a free queue), ⏭ past the last episode appends the next one, Pepe's cam (staff only, allow_library, busy -> label,
// replace, next row, IRL -> queued; the ⏰ row plays later / is missed on a price change), rpm, the rate limit, "continue",
// and the browser routes still answering as before (playFor / startFor).
//   TZ=UTC node --test test/plexchat.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexchat-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SECRET = "p".repeat(48);
process.env.MEDIACTL_SECRET = SECRET;
delete process.env.MEDIACTL_TLS_SHA256;

const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const conf = require(path.join(repo, "mediaconf"));
const L = require(path.join(repo, "medialib"));
const Q = require(path.join(repo, "mediaqueue"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const OA = require(path.join(repo, "onair"));
const OQ = require(path.join(repo, "onairqueue"));
const golive = require(path.join(repo, "golive"));
const PC = require(path.join(repo, "plexchat"));
const M = require(path.join(repo, "deploy", "mediactl", "mediactl.js"));

// ── a Plex: six films, The Office (US) (S1: 2, S2: 3 episodes) and The Office (UK) (S2: 2) ──
const media = path.join(tmp, "media");
fs.mkdirSync(media, { recursive: true });
const FILE = path.join(media, "film.mkv");
fs.writeFileSync(FILE, "x");
const MOV = {
  100: ["The Matrix", 1999, 8160], 101: ["Alien", 1979, 7020], 102: ["Aliens", 1986, 8220], 103: ["Alien: Romulus", 2024, 7140],
  104: ["Heat", 1995, 10200], 105: ["Spirited Away", 2001, 7500],
};
const EPS = {
  201: ["200", "The Office (US)", 1, 1, "Pilot"], 202: ["200", "The Office (US)", 1, 2, "Diversity Day"], 203: ["200", "The Office (US)", 2, 1, "The Dundies"],
  204: ["200", "The Office (US)", 2, 2, "Sexual Harassment"], 205: ["200", "The Office (US)", 2, 3, "Office Olympics"],
  301: ["300", "The Office (UK)", 2, 1, "Merger"], 302: ["300", "The Office (UK)", 2, 2, "Appraisals"],
};
const SHOWS = { 200: ["The Office (US)", 2005], 300: ["The Office (UK)", 2001] };
const EPDUR = 1320;
const epBrief = (k) => { const e = EPS[k]; return { key: String(k), type: "episode", title: e[4], show: e[1], season: e[2], episode: e[3], duration: EPDUR, show_key: e[0], season_key: e[0] + e[2] }; };
const movBrief = (k) => ({ key: String(k), type: "movie", title: MOV[k][0], year: MOV[k][1], duration: MOV[k][2] });
const showBrief = (k) => ({ key: String(k), type: "show", title: SHOWS[k][0], year: SHOWS[k][1], leafs: Object.values(EPS).filter((e) => e[0] === String(k)).length });
const plex = {
  async search(q) {
    const w = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (t) => w.every((x) => t.toLowerCase().includes(x));
    return [...Object.keys(MOV).filter((k) => hit(MOV[k][0])).map(movBrief), ...Object.keys(SHOWS).filter((k) => hit(SHOWS[k][0])).map(showBrief)];
  },
  async item(key) {
    if (MOV[key]) return { ...movBrief(key), file: FILE, width: 1920, height: 1080, hdr: false, audio: [{ index: 1, label: "English", lang: "eng", default: true }], subs: [] };
    if (SHOWS[key]) return { ...showBrief(key), episodes: Object.keys(EPS).filter((k) => EPS[k][0] === key).reverse().map(epBrief) };
    if (EPS[key]) return { ...epBrief(key), file: FILE, width: 1920, height: 1080, hdr: false, audio: [{ index: 1, label: "English", lang: "eng", default: true }], subs: [] };
    const e = new Error("Not in the Plex library"); e.status = 404; throw e;
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
const mcfg = M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_MEDIA_ROOTS: media + path.sep, PLEX_TOKEN: "t", MEDIACTL_MAX_STREAMS: "3" });
const mstreams = M.makeStreams(mcfg, plex, fakeSpawn, undefined, async () => null);
const { server } = M.makeServer(mcfg, { plex, streams: mstreams });

let n = 0;
async function mkUser(name, { cls = "pleb", balance = 0, login = null, auto = false, archived = false } = {}) {
  const id = "u" + (++n);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, email, auto_source, archived_at)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, ?)`,
    [id, name, name, cls, balance, login, auto ? "" : name + "@x.test", auto ? "camfrog" : null, archived ? Date.now() : null]);
  return { userId: id, username: name, class: cls, login };
}
const LOUNGE = "Players__lounge", SECOND = "Second.Room", THIRD = "Third.Room", PRIV = "Private.Room", ADULT = "Adult.Room";
const call = (body) => PC.handle(body);
const asL = (u) => ({ login: u.login });
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
async function stopAll() {
  for (const r of [LOUNGE, SECOND, THIRD, rooms.HOUSE_ROOM]) await L.stop(U.admin, r).catch(() => {});
}
const U = {};
let base, app_server;

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.MEDIACTL_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, email TEXT, discordId TEXT, twitchId TEXT, auto_source TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ max_concurrent: 8, idle_grace_min: 5, enabled: true, min_minutes: 2, max_minutes: 60, bookings_per_hour: 100 }, "test");
  await L.init();
  require(path.join(repo, "shop"));
  for (let i = 0; i < 100 && !(await getQuery("SELECT 1 FROM sqlite_master WHERE name = 'shop_order_events'")).length; i++) await new Promise((r) => setTimeout(r, 20));
  U.admin = await mkUser("boss", { cls: "Admin" });
  U.alice = await mkUser("alice_patv", { login: "alice" });                       // a Plex member (the override list)
  U.bob = await mkUser("bob_patv", { login: "bob", balance: 2000000 });           // pays
  U.dave = await mkUser("dave_patv", { login: "dave", balance: 1000 });           // pays, can't afford much
  U.owner = await mkUser("owner_patv", { login: "ownerguy" });                    // owns the lounge pad
  U.maya = await mkUser("maya_patv", { cls: "Staff", login: "maya", balance: 2000000 });   // site Staff (on-air)
  U.cf = await mkUser("CFab12cd34", { login: "cfguy", auto: true });              // Pepe's auto account only
  U.gone = await mkUser("gone_patv", { login: "goner", archived: true });
  U.erin = await mkUser("erin_patv", { balance: 2000000 });                       // web only: no chat login
  await conf.set({ library_enabled: true, library_plex: true, library_price: 50000, library_daily_cap: 3, library_free_daily_cap: 5,
                   library_users: U.alice.username, library_queue_announce_min: 20 }, "test");
  for (const [id, t] of [[LOUNGE, "Players Lounge"], [SECOND, "Second"], [THIRD, "Third"], [PRIV, "Private"], [ADULT, "Adult"]]) await rooms.addRoom(id, t, "test");
  await runQuery("UPDATE rooms_registry SET owner_kind = 'user', owner_user_id = ? WHERE room_id = ?", [U.owner.userId, LOUNGE]);
  await runQuery("UPDATE rooms_registry SET adult = 1 WHERE room_id = ?", [ADULT]);
  await rooms.loadCache();
  await PA.init();
  await runQuery("INSERT INTO pad_access (room_id, level) VALUES (?, 'approved')", [PRIV]);
  await PA.load();
  await OA.init();
  await OA.saveConfig({ enabled: true, allow_library: false }, "test");
  golive.nowPlaying = async () => ({ announced: true });                         // counted elsewhere - never sent here
  const app = express();
  PC.register(app, { isBotToken: (t) => t === "bot-token" });
  app_server = app.listen(0);
  base = "http://127.0.0.1:" + app_server.address().port;
});
test.after(() => { mstreams.stopAll(); server.close(); if (app_server) app_server.close(); });

test("the bot route: the bot token is required, 16 kB bodies at most, no-store", async () => {
  let r = await fetch(base + "/api/medialib/bot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "np", room: LOUNGE }) });
  assert.equal(r.status, 403);
  r = await fetch(base + "/api/medialib/bot", { method: "POST", headers: { "Content-Type": "application/json" },
                                                 body: JSON.stringify({ password: "bot-token", op: "np", as: asL(U.alice), room: LOUNGE, pad: "x".repeat(20000) }) });
  assert.equal(r.status, 413, "a body over 16 kB is refused");
  r = await fetch(base + "/api/medialib/bot", { method: "POST", headers: { "Content-Type": "application/json" },
                                                 body: JSON.stringify({ password: "bot-token", op: "np", as: asL(U.alice), room: LOUNGE }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.on, false);
});

test("who is speaking: a linked login, a CF auto account / no account -> link, user_id, an archived account -> account", async () => {
  assert.equal((await PC.resolve({ login: "ALICE" })).userId, U.alice.userId, "case-insensitive linked login");
  await assert.rejects(PC.resolve({ login: "cfguy" }), (e) => e.code === "link", "only a CF auto account");
  await assert.rejects(PC.resolve({ login: "nobody" }), (e) => e.code === "link");
  await assert.rejects(PC.resolve({ login: "u:" + U.erin.userId }), (e) => e.code === "link", "an account nick is never a login");
  assert.equal((await PC.resolve({ user_id: U.erin.userId })).username, U.erin.username);
  await assert.rejects(PC.resolve({ login: "goner" }), (e) => e.code === "account");
  // a real account beats an auto one sharing the login
  const twin = await mkUser("CFzz99yy88", { login: "alice", auto: true });
  assert.equal((await PC.resolve({ login: "alice" })).userId, U.alice.userId);
  await runQuery("DELETE FROM users WHERE userId = ?", [twin.userId]);
  const r = await call({ op: "search", as: { login: "cfguy" }, room: LOUNGE, q: "matrix" });
  assert.deepEqual([r.ok, r.code], [false, "link"]);
});

test("access: off -> off; a member searches free, a payer sees the price; never a file; a show + season is a season row", async () => {
  await conf.set({ library_plex: false }, "test");
  let r = await call({ op: "search", as: asL(U.bob), room: LOUNGE, q: "matrix" });
  assert.deepEqual([r.ok, r.code], [false, "off"]);
  await conf.set({ library_plex: true }, "test");
  r = await call({ op: "search", as: asL(U.alice), room: LOUNGE, q: "matrix" });
  assert.equal(r.ok, true);
  assert.equal(r.free, true);
  assert.equal(r.rows.length, 1);
  assert.deepEqual([r.rows[0].key, r.rows[0].title, r.rows[0].year, r.rows[0].price, r.rows[0].exact], ["100", "The Matrix", 1999, 0, true]);
  assert.equal(r.state.room, LOUNGE);
  assert.ok(!JSON.stringify(r).includes(FILE) && !JSON.stringify(r).includes('"file"'), "no file path ever leaves");
  r = await call({ op: "search", as: asL(U.bob), room: LOUNGE, q: "alien" });
  assert.equal(r.free, false);
  assert.deepEqual(r.rows.map((x) => x.key), ["101", "102", "103"]);
  assert.equal(r.rows[0].price, 100000, "1h57 = 2 started hours x 50,000");
  r = await call({ op: "search", as: asL(U.bob), room: LOUNGE, q: "alien", year: 1986 });
  assert.equal(r.rows[0].key, "102", "a year picks that one first");
  r = await call({ op: "search", as: asL(U.alice), room: LOUNGE, q: "the office", season: 2 });
  const us = r.rows.find((x) => x.show === "The Office (US)");
  assert.deepEqual([us.type, us.key, us.season, us.items, us.total_sec, us.scope], ["season", "203", 2, 3, 3 * EPDUR, "season"]);
  assert.ok(r.rows.find((x) => x.show === "The Office (UK)" && x.items === 2));
  r = await call({ op: "search", as: asL(U.alice), room: LOUNGE, q: "the office", season: 2, episode: 2 });
  assert.deepEqual([r.rows[0].type, r.rows[0].key, r.rows[0].label], ["episode", "204", 'The Office (US) S2E2 "Sexual Harassment"']);
  r = await call({ op: "search", as: asL(U.bob), room: LOUNGE, q: "the office", season: 2 });
  assert.equal(r.rows.find((x) => x.show === "The Office (US)").estimate, 100000, "a paid season: 3 x 22 min = 66 min -> 2 started hours x 50,000");
  assert.equal(r.rows.find((x) => x.show === "The Office (UK)").estimate, 50000);
});

test("the pad's visibility: an Approved pad they aren't inside and an 18+ pad (gate on, not confirmed) read as no such pad", async () => {
  let r = await call({ op: "search", as: asL(U.alice), room: PRIV, q: "matrix" });
  assert.deepEqual([r.ok, r.code], [false, "pad"]);
  r = await call({ op: "play", as: asL(U.alice), room: PRIV, key: "100", scope: "title" });
  assert.deepEqual([r.ok, r.code], [false, "pad"]);
  const GATE = require(path.join(repo, "adultgate"));
  await GATE.setEnabled(true, U.admin, "test");
  try {
    r = await call({ op: "search", as: asL(U.alice), room: ADULT, q: "matrix" });
    assert.deepEqual([r.ok, r.code], [false, "pad"]);
  } finally { await GATE.setEnabled(false, U.admin, "test"); }
  r = await call({ op: "search", as: asL(U.alice), room: "No.Such.Room", q: "matrix" });
  assert.deepEqual([r.ok, r.code], [false, "pad"]);
});

test("play on the stage: a member's film is free; own slot -> has_slot; the pad busy -> busy_library; the daily cap -> cap", async () => {
  let r = await call({ op: "play", as: asL(U.alice), room: LOUNGE, key: "100", scope: "title" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.title, r.price, r.target], ["The Matrix (1999)", 0, "stage"]);
  const slot = (await getQuery("SELECT * FROM stage_slots WHERE room_id = ? AND source = 'library' AND status IN ('waiting','active')", [LOUNGE]))[0];
  assert.ok(slot && slot.userId === U.alice.userId, "the slot is the member's (their account)");
  r = await call({ op: "play", as: asL(U.alice), room: SECOND, key: "104", scope: "title" });
  assert.deepEqual([r.ok, r.code], [false, "has_slot"]);
  r = await call({ op: "play", as: asL(U.bob), room: LOUNGE, key: "101", scope: "title", price: 100000 });
  assert.deepEqual([r.ok, r.code], [false, "busy_library"]);
  const st = await call({ op: "search", as: asL(U.bob), room: LOUNGE, q: "heat" });
  assert.equal(st.state.library.title, "The Matrix (1999)");
  assert.equal(st.state.library.starter_is_you, false);
  await stopAll();
  await conf.set({ library_free_daily_cap: 1 }, "test");
  try {
    r = await call({ op: "play", as: asL(U.alice), room: LOUNGE, key: "100", scope: "title" });
    assert.deepEqual([r.ok, r.code, r.cap], [false, "cap", 1]);
  } finally { await conf.set({ library_free_daily_cap: 5 }, "test"); }
});

test("a paid film: no price -> price (400), a changed one -> price (409) with the new figure, the right one -> held; too poor -> pat", async () => {
  let r = await call({ op: "play", as: asL(U.bob), room: LOUNGE, key: "101", scope: "title" });
  assert.deepEqual([r.ok, r.code, r.price], [false, "price", 100000]);
  r = await call({ op: "play", as: asL(U.bob), room: LOUNGE, key: "101", scope: "title", price: 50000 });
  assert.deepEqual([r.ok, r.code, r.price], [false, "price", 100000]);
  const before = await bal(U.bob);
  r = await call({ op: "play", as: asL(U.bob), room: LOUNGE, key: "101", scope: "title", price: 100000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.price, 100000);
  assert.equal(before - (await bal(U.bob)), 100000, "held from the payer");
  r = await call({ op: "play", as: asL(U.dave), room: SECOND, key: "104", scope: "title", price: 150000 });
  assert.deepEqual([r.ok, r.code, r.need, r.have], [false, "pat", 150000, 1000]);
  await stopAll();
});

test("every encoder busy -> encoder_busy (with the counts)", async () => {
  for (const [room, key] of [[LOUNGE, "100"], [SECOND, "101"], [THIRD, "102"]]) assert.equal((await L.play(U.admin, { room, key })).ok, true);
  const r = await call({ op: "play", as: asL(U.alice), room: rooms.HOUSE_ROOM, key: "104", scope: "title" });
  assert.deepEqual([r.ok, r.code, r.max], [false, "encoder_busy", 3]);
  await stopAll();
});

test("controls: a stranger gets control_denied; the starter pauses / resumes / skips ahead (seek_rel) / stops; the pad owner may too", async () => {
  let r = await call({ op: "play", as: asL(U.alice), room: LOUNGE, key: "100", scope: "title" });
  assert.equal(r.ok, true);
  r = await call({ op: "control", as: asL(U.dave), room: LOUNGE, action: "stop" });
  assert.deepEqual([r.ok, r.code], [false, "control_denied"]);
  r = await call({ op: "np", as: asL(U.dave), room: LOUNGE });
  assert.deepEqual([r.ok, r.on, r.title, r.can_control], [true, true, "The Matrix (1999)", false], "anyone who sees the pad may ask what's on");
  r = await call({ op: "control", as: asL(U.alice), room: LOUNGE, action: "seek_rel", value: 300 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.to, "5:00");
  r = await call({ op: "control", as: asL(U.alice), room: LOUNGE, action: "pause" });
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await call({ op: "control", as: asL(U.owner), room: LOUNGE, action: "resume" });
  assert.equal(r.ok, true, "the pad's owner may control it (rooms.canManage)");
  r = await call({ op: "control", as: asL(U.alice), room: LOUNGE, action: "next" });
  assert.deepEqual([r.ok, r.code], [false, "last_title"], "a single film has no next");
  r = await call({ op: "control", as: asL(U.alice), room: LOUNGE, action: "stop" });
  assert.equal(r.ok, true);
  r = await call({ op: "control", as: asL(U.alice), room: LOUNGE, action: "pause" });
  assert.deepEqual([r.ok, r.code], [false, "nothing_on"]);
  await stopAll();
});

test("a season on the stage (one queue); 'queue next': the starter yes, someone else on a paid queue not_starter, a free queue's controllers yes", async () => {
  // free (member): the US season 2
  let r = await call({ op: "play", as: asL(U.alice), room: LOUNGE, key: "203", scope: "season" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.queue, r.items, r.title], [true, 3, "The Office (US) — S2E1 The Dundies"]);
  r = await call({ op: "play", as: asL(U.bob), room: LOUNGE, key: "100", scope: "title", mode: "next" });
  assert.deepEqual([r.ok, r.code], [false, "not_starter"], "not theirs and they can't control it");
  r = await call({ op: "play", as: asL(U.owner), room: LOUNGE, key: "100", scope: "title", mode: "next" });
  assert.equal(r.ok, true, "a FREE queue: the pad owner (a controller) may add - nobody is billed");
  r = await call({ op: "play", as: asL(U.alice), room: LOUNGE, key: "105", scope: "title", mode: "next" });
  assert.deepEqual([r.ok, r.queued, r.title], [true, true, "Spirited Away (2001)"]);
  const q = await Q.activeFor(LOUNGE);
  assert.deepEqual(q.items.map((x) => x.key), ["203", "105", "100", "204", "205"], "each lands right after what's on");
  await stopAll();
  // paid (bob): the estimate first, then only bob may add
  r = await call({ op: "play", as: asL(U.bob), room: SECOND, key: "201", scope: "season" });
  assert.deepEqual([r.ok, r.code, r.estimate], [false, "estimate", 50000]);
  r = await call({ op: "play", as: asL(U.bob), room: SECOND, key: "201", scope: "season", estimate: 50000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await call({ op: "play", as: { user_id: U.admin.userId }, room: SECOND, key: "100", scope: "title", mode: "next" });
  assert.deepEqual([r.ok, r.code], [false, "not_starter"], "never on someone else's PAT - not even a library admin (a controller)");
  r = await call({ op: "play", as: asL(U.bob), room: SECOND, key: "105", scope: "title", mode: "next" });
  assert.equal(r.ok, true);
  await stopAll();
});

test("⏭ past the last title of an episode queue plays the show's next episode (appended); a movie / the series end stays last_title", async () => {
  let r = await call({ op: "play", as: asL(U.alice), room: LOUNGE, key: "202", scope: "episode" });
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await call({ op: "control", as: asL(U.alice), room: LOUNGE, action: "next" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.title, "The Office (US) — S2E1 The Dundies", "S1E2 -> S2E1 (across the season)");
  const q = await Q.activeFor(LOUNGE);
  assert.deepEqual(q.items.map((x) => x.key), ["202", "203"]);
  r = await call({ op: "np", as: asL(U.bob), room: LOUNGE });
  assert.equal(r.title, "The Office (US) — S2E1 The Dundies");
  await stopAll();
  r = await call({ op: "play", as: asL(U.alice), room: LOUNGE, key: "205", scope: "episode" });
  r = await call({ op: "control", as: asL(U.alice), room: LOUNGE, action: "next" });
  assert.deepEqual([r.ok, r.code], [false, "last_title"], "the series' last episode");
  await stopAll();
});

test("continue: the speaker's next episode from their last 14 days", async () => {
  const r = await call({ op: "continue", as: asL(U.alice), room: LOUNGE });
  assert.equal(r.ok, true);
  assert.equal(r.row, null, "205 was the last one - nothing after it");
  await runQuery("UPDATE media_plays SET ts = 0 WHERE user_id = ? AND rating_key = '205'", [U.alice.userId]);
  const r2 = await call({ op: "continue", as: asL(U.alice), room: LOUNGE, show: "The Office (US)" });
  assert.equal(r2.row.key, "204", "the newest play left in the window is 203 -> 204");
  const r3 = await call({ op: "continue", as: asL(U.dave), room: LOUNGE });
  assert.equal(r3.row, null);
});

test("Pepe's cam: non-staff onair_staff; allow_library off; busy -> onair_busy with what's on; next -> a ⏰ row; replace; IRL -> queued", async () => {
  let r = await call({ op: "search", as: asL(U.bob), room: LOUNGE, q: "alien", target: "cam" });
  assert.deepEqual([r.ok, r.code], [false, "onair_staff"]);
  r = await call({ op: "play", as: asL(U.bob), room: LOUNGE, key: "101", scope: "title", target: "cam" });
  assert.deepEqual([r.ok, r.code], [false, "onair_staff"]);
  r = await call({ op: "search", as: asL(U.maya), room: LOUNGE, q: "alien", target: "cam" });
  assert.deepEqual([r.ok, r.code], [false, "onair_library_off"]);
  await OA.saveConfig({ allow_library: true }, "test");
  r = await call({ op: "play", as: asL(U.maya), room: LOUNGE, key: "101", scope: "title", target: "cam", price: 100000 });
  assert.deepEqual([r.ok, r.code], [false, "pepe_away"], "Pepe hasn't checked in");
  await OA.forBot({ state: { obs: "ok" } });
  r = await call({ op: "search", as: asL(U.maya), room: LOUNGE, q: "alien", target: "cam" });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].price, 100000, "Staff aren't library admins (library_allow = admins): they pay like anyone");
  // something else is on air: a live slot from another pad
  const host = await mkUser("hoster");
  const b = await S.book(host, { minutes: 30, room: THIRD });
  assert.equal((await S.rtmpCallback({ call: "publish", app: "stage", name: b.key, addr: "1.2.3.4", clientid: "77" })).status, 302);
  await OA.setSlot(b.slot.id, "web:boss", { ask: false });
  r = await call({ op: "play", as: asL(U.maya), room: LOUNGE, key: "101", scope: "title", target: "cam", price: 100000 });
  assert.deepEqual([r.ok, r.code], [false, "onair_busy"]);
  assert.match(r.label, /hoster/, "what's on, so Pepe can say it");
  r = await call({ op: "play", as: asL(U.maya), room: LOUNGE, key: "101", scope: "title", target: "cam", price: 100000, mode: "next" });
  assert.deepEqual([r.ok, r.queued, r.target], [true, true, "cam"]);
  let rows = (await OQ.list()).filter((x) => x.kind === "library");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "📼 Alien (1979)");
  assert.equal(rows[0].owner.userId, U.maya.userId);
  r = await call({ op: "play", as: asL(U.maya), room: LOUNGE, key: "100", scope: "title", target: "cam", price: 150000, mode: "replace" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(OA.view().target.pad, rooms.HOUSE_ROOM, "replaced: the house pad's 📼 slot is the pick");
  assert.ok((await getQuery("SELECT 1 FROM onair_log WHERE what = 'replaced'")).length, "logged as replaced");
  // the IRL feed is live: a pick is queued, never on top
  await OA.forBot({ state: { obs: "ok", irl: true } });
  r = await call({ op: "play", as: asL(U.maya), room: LOUNGE, key: "105", scope: "title", target: "cam", price: 150000 });
  assert.deepEqual([r.ok, r.queued, r.irl], [true, true, true]);
  rows = (await OQ.list()).filter((x) => x.kind === "library");
  assert.equal(rows.length, 2);
  assert.equal(await OQ.due({ idleMain: true, enabled: true, irl: true }), null, "a 📼 row waits while IRL is live");
  assert.equal((await OQ.due({ idleMain: true, enabled: true, irl: false })).kind, "library");
  await OA.forBot({ state: { obs: "ok", irl: false } });
  await S.end(b.slot.id, "test", "test").catch(() => {});
});

test("a queued 📼 row plays when the main lane is free (under its owner), and is missed when its price changed", async () => {
  await L.stop(U.admin, rooms.HOUSE_ROOM).catch(() => {});
  await OA.clear("test", "test");
  await conf.set({ library_price: 60000 }, "test");          // Alien was confirmed at 100,000: 2 h x 60,000 = 120,000 now
  await OA.check();
  let rows = await OQ.recent(10);
  const alien = rows.find((x) => x.label === "📼 Alien (1979)");
  assert.equal(alien.status, "missed");
  assert.equal(alien.why, "price changed");
  await conf.set({ library_price: 50000 }, "test");
  await OA.forBot({ state: { obs: "ok" } });
  await OA.check();
  rows = await OQ.recent(10);
  const spirited = rows.find((x) => x.label === "📼 Spirited Away (2001)");
  assert.equal(spirited.status, "played", JSON.stringify(spirited));
  assert.equal(OA.view().target.pad, rooms.HOUSE_ROOM);
  const slot = await S.getSlot(OA.view().target.slot_id);
  assert.equal(slot.userId, U.maya.userId, "played under the person who queued it");
  await OA.clear("test", "test");
  await stopAll();
  await OA.saveConfig({ allow_library: false }, "test");
});

test("rpm: a private row only for that account, only on a pad it sees", async () => {
  const RP = require(path.join(repo, "roompm"));
  let r = await call({ op: "rpm", as: { user_id: U.erin.userId }, room: LOUNGE, text: "you already have a stage slot - end it first" });
  assert.equal(r.ok, true);
  const mine = RP.since(U.erin.userId, LOUNGE, 0);
  if (RP.on && RP.on()) assert.equal(mine.rows.length, 1);
  assert.equal(RP.since(U.bob.userId, LOUNGE, 0).rows.length, 0, "nobody else gets it");
  r = await call({ op: "rpm", as: { user_id: U.erin.userId }, room: PRIV, text: "hi" });
  assert.deepEqual([r.ok, r.code], [false, "pad"]);
});

test("web chat speakers act as their ACCOUNT (user_id), with no chat login at all", async () => {
  let r = await call({ op: "search", as: { user_id: U.erin.userId }, via: "web", room: LOUNGE, q: "spirited away" });
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].price, 150000, "2h05 = 3 started hours");
  r = await call({ op: "play", as: { user_id: U.erin.userId }, via: "web", room: LOUNGE, key: "105", scope: "title", price: 150000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  r = await call({ op: "play", as: { user_id: U.erin.userId }, via: "web", room: SECOND, key: "104", scope: "title", price: 150000 });
  assert.deepEqual([r.ok, r.code], [false, "has_slot"]);
  await stopAll();
});

test("the rate limit: 30 ops a minute per account, then rate", async () => {
  let T = 5_000_000_000_000;
  PC._setClock(() => T);
  PC._hits.clear();
  try {
    for (let i = 0; i < PC.RATE_MAX; i++) assert.equal((await call({ op: "np", as: asL(U.dave), room: LOUNGE })).ok, true);
    const r = await call({ op: "np", as: asL(U.dave), room: LOUNGE });
    assert.deepEqual([r.ok, r.code], [false, "rate"]);
    assert.equal((await call({ op: "np", as: asL(U.bob), room: LOUNGE })).ok, true, "per account");
    T += 61 * 1000;
    assert.equal((await call({ op: "np", as: asL(U.dave), room: LOUNGE })).ok, true, "a minute later");
  } finally { PC._setClock(null); PC._hits.clear(); }
});

test("codes: every refusal maps to a stable code (aliases, the shop's 402, status fallbacks)", () => {
  const R = L.Refuse;
  assert.equal(PC.codeOf(new R(409, "x", { code: "has_slot" })), "has_slot");
  assert.equal(PC.codeOf(Object.assign(new Error("full"), { code: "full", refuse: true })), "queue_full");
  assert.equal(PC.codeOf(Object.assign(new Error("That costs 5 PAT and you have 1."), { status: 402, refuse: true })), "pat");
  assert.equal(PC.codeOf(Object.assign(new Error("No such pad."), { status: 404, refuse: true })), "pad");
  assert.equal(PC.codeOf(Object.assign(new Error("boom"), {})), "error");
  const b = PC.failBody(Object.assign(new Error("That costs 150,000 PAT and you have 12,400."), { status: 402, refuse: true }));
  assert.deepEqual([b.code, b.need, b.have], ["pat", 150000, 12400]);
});

test("the browser routes answer as before (playFor / startFor carry the pad check)", async () => {
  await assert.rejects(L.playFor(U.alice, { room: PRIV, key: "100" }), (e) => e.status === 404 && /No such pad/.test(e.message));
  await assert.rejects(Q.startFor(U.alice, { room: PRIV, key: "203", scope: "season" }), (e) => e.status === 404);
  await assert.rejects(Q.bookFor(U.alice, { room: PRIV, key: "203", scope: "season" }), (e) => e.status === 404);
  const r = await L.playFor(U.alice, { room: LOUNGE, key: "100", _carry: { id: 1, charge: "held", price: 99 } });
  assert.equal(r.ok, true);
  const p = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [r.play_id]))[0];
  assert.equal(p.carried_from, null, "_carry is never taken from a request");
  await stopAll();
});
