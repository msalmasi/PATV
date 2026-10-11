// 1.99kp: 🎥 go-live alerts + stream-start announcements (golive.js), 📡 Pepe's rooms from the site (roomctl.js),
// the homepage's "now playing" (home.nowPlaying) and the 📼 Plex hub (plexhub.js + views/plex.ejs).
//   node --test test/golive-roomctl.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golive-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.TWITCH_CLIENT_ID;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const rooms = require(path.join(repo, "rooms"));
const follows = require(path.join(repo, "follows"));
const golive = require(path.join(repo, "golive"));
const roomctl = require(path.join(repo, "roomctl"));
const home = require(path.join(repo, "home"));
const PA = require(path.join(repo, "padaccess"));

const ROOM = { id: "Live.Room", name: "Live Room" };
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)",
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null]);
  U[name] = { userId: id, username: name, class: extra.class || "pleb" };
  return U[name];
}
const goliveJobs = () => [...relay._jobs.values()].filter((j) => j.kind === "golive");
const inboxOf = async (u) => getQuery("SELECT kind, title, body, link, ref FROM inbox WHERE user_id = ? AND kind = 'golive'", [u.userId]);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 0)`);
  await require(path.join(repo, "inbox")).ready;
  await mkUser("streamer", { display: "Star ✨", camfrog: "starcf" });
  await mkUser("fan");            // follows the streamer
  await mkUser("padfan");         // follows the pad
  await mkUser("both");           // follows both (one notice)
  await mkUser("blocker");        // follows, but blocked the streamer
  await mkUser("quiet");          // follows, alerts off globally
  await mkUser("muted1");         // follows, this follow's alerts off
  await mkUser("pmfan", { camfrog: "pmfancf" });   // wants a Pepe PM too
  await mkUser("admin", { class: "Admin" });
  await PA.init();
  await bridge.ingest({ rooms: [{ room: ROOM, members: [{ id: "a", login: "a", display: "A" }], mic: [{ id: "a", login: "a", display: "Ann" }], count: 1 }], events: [] });
  await rooms.init();
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await new Promise((r) => setTimeout(r, 20));
  await golive.init();
  await follows.follow(U.fan, "user", "streamer");
  await follows.follow(U.padfan, "room", ROOM.id);
  await follows.follow(U.both, "user", "streamer");
  await follows.follow(U.both, "room", ROOM.id);
  await follows.follow(U.blocker, "user", "streamer");
  await follows.follow(U.quiet, "room", ROOM.id);
  await follows.follow(U.muted1, "room", ROOM.id);
  await follows.follow(U.pmfan, "user", "streamer");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)", [U.blocker.userId, U.streamer.userId]);
  await golive.setPrefs(U.quiet, { alerts: false });
  await golive.setFollow(U.muted1, "room", ROOM.id, false);
  await golive.setPrefs(U.pmfan, { pm: true });
});

test("a slot going live: followers of the streamer and of the pad get one notice; blocks, opt-outs and the streamer are skipped", async () => {
  const s = { id: "slot1", room_id: ROOM.id, userId: U.streamer.userId, username: "streamer", displayname: "Star ✨", title: "Late night jams", mode: "stream" };
  const r = await golive.onSlot(s);
  assert.equal(r.notified, 4, JSON.stringify(r));
  for (const n of ["fan", "padfan", "both", "pmfan"]) {
    const box = await inboxOf(U[n]);
    assert.equal(box.length, 1, n + " gets one notice");
    assert.equal(box[0].title, "🎥 Star ✨ is live on Live Room");
    assert.equal(box[0].body, "Late night jams");
    assert.match(box[0].link, /^\/p\//);
  }
  for (const n of ["blocker", "quiet", "muted1", "streamer"]) assert.equal((await inboxOf(U[n])).length, 0, n + " gets nothing");
  const pm = await getQuery("SELECT args FROM pepe_actions WHERE kind = 'notify' AND user_id = ?", [U.pmfan.userId]);
  assert.equal(pm.length, 1, "the PM-me follower gets a Pepe PM");
  assert.match(JSON.parse(pm[0].args)[1], /Star ✨ is live on Live Room/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'notify' AND user_id = ?", [U.fan.userId]))[0].n, 0, "PMs are opt-in");
  // the pad: a "live" line in its chat on PATV + Pepe's job for the Camfrog room
  const R = bridge._rooms.get(ROOM.id);
  const it = R.feed[R.feed.length - 1];
  assert.equal(it.k, "live");
  assert.deepEqual({ who: it.who, pad: it.pad, what: it.what }, { who: "Star ✨", pad: "Live Room", what: "Late night jams" });
  const jobs = goliveJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].camfrog, "starcf");
  assert.match(jobs[0].link, /^https:\/\/publicaccess\.tv\/p\//);
  const offered = relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "golive");
  assert.equal(offered.length, 1);
  assert.deepEqual({ streamer: offered[0].streamer, pad: offered[0].pad, what: offered[0].what }, { streamer: "Star ✨", pad: "Live Room", what: "Late night jams" });
  assert.equal(relay.takeJobs(new Set([ROOM.id])).filter((x) => x.kind === "golive").length, 0, "offered once");
});

test("once per stream, and a quick comeback (reconnect / next slot) doesn't alert or announce again", async () => {
  const s = { id: "slot1", room_id: ROOM.id, userId: U.streamer.userId, username: "streamer", displayname: "Star ✨", title: "again", mode: "stream" };
  assert.deepEqual(await golive.onSlot(s), { dup: true });
  const r = await golive.onSlot({ ...s, id: "slot2" });
  assert.equal(r.again, true);
  assert.equal(r.notified, 0);
  assert.equal(r.announced, false);
  assert.equal((await inboxOf(U.fan)).length, 1);
});

test("the pad owner can switch the announcement off; followers still hear", async () => {
  golive._setClock(() => Date.now() + 2 * 3600e3);
  try {
    await golive.setPadAnnounce(U.admin, ROOM.id, false);
    assert.equal(await golive.padAnnounce(ROOM.id), false);
    const before = goliveJobs().length;
    const r = await golive.onLive({ key: "slot:x9", roomId: ROOM.id, userId: U.streamer.userId, display: "Star ✨", what: "📼 Spirited Away (2001)", source: "plex" });
    assert.ok(r.notified > 0);
    assert.equal(r.announced, false);
    assert.equal(goliveJobs().length, before);
    await assert.rejects(golive.setPadAnnounce(U.fan, ROOM.id, true), /owner/);
    await golive.setPadAnnounce(U.admin, ROOM.id, true);
  } finally { golive._setClock(null); }
});

test("whatOf: the title, else an embed's label", () => {
  assert.equal(golive.whatOf({ title: "📼 Heat (1995)" }), "📼 Heat (1995)");
  assert.equal(golive.whatOf({ mode: "embed", embed: JSON.stringify({ p: "youtube", t: "video", id: "dQw4w9WgXcQ" }) }), "YouTube video");
  assert.equal(golive.whatOf({}), "");
});

test("follows.lists carries each follow's go-live switch", async () => {
  const L = await follows.lists(U.muted1.userId);
  assert.equal(L.rooms[0].live, false);
  const F = await follows.lists(U.fan.userId);
  assert.equal(F.people[0].live, true);
  await assert.rejects(golive.setFollow(U.fan, "room", ROOM.id, false), /Follow them first/);
});

test("now playing: the live slot wins, then Twitch, then who's on the mic", async () => {
  const MS = require(path.join(repo, "mainstage"));
  const orig = MS.publicSlots;
  try {
    MS.publicSlots = async () => [{ room_id: ROOM.id, display: "Star", title: "📼 Heat (1995)", embed: null }];
    let np = await home.nowPlaying([{ id: ROOM.id, mic: ["Ann"], micCount: 1 }]);
    assert.deepEqual(np.get(ROOM.id), { k: "plex", title: "Heat (1995)", name: "Star" });
    MS.publicSlots = async () => [{ room_id: ROOM.id, display: "Star", title: "Jams", embed: null }];
    np = await home.nowPlaying([{ id: ROOM.id, mic: [], micCount: 0 }]);
    assert.deepEqual(np.get(ROOM.id), { k: "stage", name: "Star", title: "Jams" });
    MS.publicSlots = async () => [];
    golive._twitchLive.set(ROOM.id, { id: "1", title: "Speedrun", since: 1 });
    np = await home.nowPlaying([{ id: ROOM.id, mic: ["Ann"], micCount: 1 }]);
    assert.deepEqual(np.get(ROOM.id), { k: "twitch", title: "Speedrun" });
    golive._twitchLive.clear();
    np = await home.nowPlaying([{ id: ROOM.id, mic: ["Ann", "Bo", "Cy", "Di"], micCount: 4 }]);
    assert.deepEqual(np.get(ROOM.id), { k: "mic", names: ["Ann", "Bo", "Cy"], more: 1 });
    np = await home.nowPlaying([{ id: ROOM.id, mic: [], micCount: 2 }]);
    assert.deepEqual(np.get(ROOM.id), { k: "mic_n", n: 2 });
    np = await home.nowPlaying([{ id: ROOM.id, mic: [], micCount: 0 }]);
    assert.equal(np.get(ROOM.id), null);
  } finally { MS.publicSlots = orig; }
});

test("roomctl: Pepe's state is cleaned and kept; admins queue changes; a join password never outlives the answer", async () => {
  assert.equal(await roomctl.setState({ rooms: [{ id: "PepeFrog.Room", name: "Pepe's Pad", count: 7, mic: 1, muted: false, active: true, bridged: true, autojoin: true, evil: "<x>" }],
                                         active_room: null, active_auto: "PepeFrog.Room", net_audio: true, log: [{ ts: 1, verb: "join", room: "X", ok: true, msg: "joined X", by: "a" }],
                                         autojoin: [{ name: "Pepe's Pad", enabled: true, password: true }] }), true);
  const v = await roomctl.view();
  assert.equal(v.online, true);
  assert.deepEqual(Object.keys(v.state.rooms[0]).sort(), ["active", "autojoin", "bridged", "count", "id", "mic", "muted", "name"]);
  assert.deepEqual(v.state.autojoin, [{ name: "Pepe's Pad", enabled: true }], "never a password flag or value");
  await assert.rejects(roomctl.request(U.fan, { verb: "leave", room: "Pepe's Pad" }), /Admins only/);
  await assert.rejects(roomctl.request(U.admin, { verb: "dance", room: "Pepe's Pad" }), /Unknown/);
  await assert.rejects(roomctl.request(U.admin, { verb: "leave", room: "Nowhere" }), /isn't in that room/);
  const id1 = await roomctl.request(U.admin, { verb: "leave", room: "pepe's pad" });
  const id2 = await roomctl.request(U.admin, { verb: "join", room: "Thunderdome", password: "s3cret" });
  const id3 = await roomctl.request(U.admin, { verb: "active", room: "auto" });
  const rows = await getQuery("SELECT id, kind, args, label, site_admin FROM pepe_actions WHERE id IN (?, ?, ?) ORDER BY id", [id1, id2, id3]);
  assert.deepEqual(rows.map((r) => r.kind), ["room.ctl", "room.ctl", "room.ctl"]);
  assert.deepEqual(JSON.parse(rows[1].args), ["join", "Thunderdome", "s3cret", ""]);
  assert.doesNotMatch(rows[1].label, /s3cret/, "the label never shows the password");
  assert.equal(rows[1].site_admin, 1);
  await runQuery("UPDATE pepe_actions SET status = 'done', message = 'joined Thunderdome' WHERE id = ?", [id2]);
  await roomctl.scrubPasswords();
  const after = (await getQuery("SELECT args FROM pepe_actions WHERE id = ?", [id2]))[0];
  assert.deepEqual(JSON.parse(after.args), ["join", "Thunderdome", "", ""]);
  roomctl._setClock(() => Date.now() + 5 * 60e3);
  try { await assert.rejects(roomctl.request(U.admin, { verb: "leave", room: "Pepe's Pad" }), /isn't reporting/, "offline Pepe: refused"); }
  finally { roomctl._setClock(null); }
});

test("pages render: /plex (signed out and in), the admin rooms page, the following panel with go-live switches", async () => {
  const ejs = require("ejs");
  const hub = require(path.join(repo, "plexhub"));
  const data = await hub.pageData(null);
  let html = await ejs.renderFile(path.join(repo, "views", "plex.ejs"), { user: null, title: "Plex", ...data });
  assert.match(html, /href="\/requests"/);
  assert.match(html, /href="\/stage\?mode=plex#srcSet"/);
  assert.match(html, /to see your requests/);
  const me = await hub.pageData(U.fan);
  html = await ejs.renderFile(path.join(repo, "views", "plex.ejs"), { user: "fan", title: "Plex", ...me });
  assert.match(html, /Nothing requested yet/);
  assert.match(html, /href="\/subscriptions#plex"/);
  const i18n = require(path.join(repo, "i18n"));
  const t = i18n.tFor("de");
  const de = await ejs.renderFile(path.join(repo, "views", "plex.ejs"), { user: "fan", title: "Plex", ...me, i18nT: t, t, i18nClient: (q) => i18n.clientJson("de", q) });
  assert.ok(de.length > 1000);
  html = await ejs.renderFile(path.join(repo, "views", "admin", "pepeRooms.ejs"), { user: "admin", title: "Admin", section: "pepe", isAdmin: true, v: await roomctl.view() });
  assert.match(html, /Join a room/);
  assert.doesNotMatch(html, /s3cret/);
  html = await ejs.renderFile(path.join(repo, "views", "partials", "following-panel.ejs"),
                              { follow: { ...(await follows.lists(U.muted1.userId)), prefs: { notify: false }, golive: await golive.prefs(U.muted1.userId) }, here: "/feed/following" });
  assert.match(html, /data-golive-pref="alerts" checked/);
  assert.match(html, /data-golive-kind="room"[^>]*aria-pressed="false"/);
  const layout = fs.readFileSync(path.join(repo, "views", "layout.ejs"), "utf8");
  assert.match(layout, /\['\/plex', '📼', t\('nav\.plex'\)\]/, "navbar More + ☰");
  assert.match(layout, /<a href="\/plex">/, "footer");
});
